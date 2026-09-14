-- 001_init.sql —— 初始表结构（全量合成版）
-- 由原 001~006 合并：全新库一次建出最终结构；存量库（schema_migrations 已记录 001~006）
-- 不再重跑此文件，其库结构与本文件产物一致，无副作用。
-- 全部使用 IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / DO 守卫，重复应用安全。
--
-- 关键语义（来自原 006 软删除改造）：
--   1) name 唯一性改用「部分唯一索引」ON (name) WHERE deleted_at IS NULL，
--      整库不再存在 pipeline_name_key / credential_name_key / exec_image_name_key
--      这些裸 UNIQUE 约束 → 删除后可重建同名实体。
--   2) 正因如此，seed 与代码一律不得用 ON CONFLICT (name)（列推断只匹配约束、
--      匹配不到部分唯一索引），插入用存在性守卫。

-- ---------- pipeline ----------
CREATE TABLE IF NOT EXISTS pipeline (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  spec_json JSONB NOT NULL DEFAULT '{}',
  rev INT NOT NULL DEFAULT 1,
  webhook_secret TEXT NOT NULL DEFAULT '',    -- webhook 触发访问密钥（创建时生成）
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 存量库兼容：旧版列名迁移（仅旧列存在且新列缺失时 RENAME，保数据）
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pipeline' AND column_name = 'git_hook_secret'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pipeline' AND column_name = 'webhook_secret'
  ) THEN
    ALTER TABLE pipeline RENAME COLUMN git_hook_secret TO webhook_secret;
  END IF;
END $$;
ALTER TABLE pipeline ADD COLUMN IF NOT EXISTS webhook_secret TEXT NOT NULL DEFAULT '';
ALTER TABLE pipeline ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- 去掉旧裸 UNIQUE 约束，换部分唯一索引（幂等，防存量库残留）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_name_key') THEN
    ALTER TABLE pipeline DROP CONSTRAINT pipeline_name_key;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_name_active
  ON pipeline(name) WHERE deleted_at IS NULL;

-- ---------- pipeline_rev ----------
CREATE TABLE IF NOT EXISTS pipeline_rev (
  id BIGSERIAL PRIMARY KEY,
  pipeline_id BIGINT NOT NULL REFERENCES pipeline(id),
  rev INT NOT NULL,
  spec_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- execution ----------
CREATE TABLE IF NOT EXISTS execution (
  id BIGSERIAL PRIMARY KEY,
  pipeline_id BIGINT REFERENCES pipeline(id),
  base_id BIGINT,
  run_no INT NOT NULL,
  status TEXT NOT NULL,
  trigger JSONB,
  context JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- ---------- execution_node ----------
CREATE TABLE IF NOT EXISTS execution_node (
  id BIGSERIAL PRIMARY KEY,
  exec_id BIGINT NOT NULL REFERENCES execution(id),
  node_id TEXT NOT NULL,
  step TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  input JSONB,
  output JSONB,
  logs TEXT,                    -- 脚本 stdout/stderr 回传（原 004）
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE(exec_id, node_id)
);
ALTER TABLE execution_node ADD COLUMN IF NOT EXISTS logs TEXT;

-- ---------- webhook_registry ----------
CREATE TABLE IF NOT EXISTS webhook_registry (
  id BIGSERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  exec_id BIGINT NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- eci | dingtalk
  secret TEXT NOT NULL DEFAULT '',   -- 每个回调独立的访问密钥
  credential TEXT NOT NULL DEFAULT '',  -- 回调更新卡片状态时据此反查机器人凭证刷新 accessToken
  expires_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE webhook_registry ADD COLUMN IF NOT EXISTS secret TEXT NOT NULL DEFAULT '';
ALTER TABLE webhook_registry ADD COLUMN IF NOT EXISTS credential TEXT NOT NULL DEFAULT '';

-- ---------- webhook_probe ----------
-- webhook 触发调试探针：每个管道只留最近一次投递的原始 body 与本次处理结果。
-- http_status 记录该次投递的最终处理结果（200=触发成功、401=密钥不匹配、503=密钥未配置、
-- 500=处理抛错），避免用户只看到「已收到 body」却在鉴权/执行失败时误判链路已通。
-- 不设外键，管道删除后残留行无害；pipeline_id 用 BIGINT 对齐 pipeline.id。
CREATE TABLE IF NOT EXISTS webhook_probe (
  pipeline_id BIGINT PRIMARY KEY,
  body JSONB NOT NULL,
  http_status INT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- credential ----------
CREATE TABLE IF NOT EXISTS credential (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,          -- docker-registry | s3 | git-token | kubeconfig
  secret_enc TEXT NOT NULL,    -- SM4 加密后的 JSON（AK/SK/账号密码等）
  display_meta JSONB NOT NULL DEFAULT '{}'::jsonb,  -- 钉钉机器人展示辅助信息（原 002）
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE credential ADD COLUMN IF NOT EXISTS display_meta JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE credential ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE credential ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credential_name_key') THEN
    ALTER TABLE credential DROP CONSTRAINT credential_name_key;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_credential_name_active
  ON credential(name) WHERE deleted_at IS NULL;

-- ---------- exec_image ----------
CREATE TABLE IF NOT EXISTS exec_image (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  image TEXT NOT NULL,
  category TEXT NOT NULL,
  builtin BOOLEAN NOT NULL DEFAULT false,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE exec_image ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exec_image_name_key') THEN
    ALTER TABLE exec_image DROP CONSTRAINT exec_image_name_key;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_exec_image_name_active
  ON exec_image(name) WHERE deleted_at IS NULL;

-- ---------- execution_log ----------
-- 调度日志：非节点执行日志，记录流水线调度的完整过程（原 005）
CREATE TABLE IF NOT EXISTS execution_log (
  id BIGSERIAL PRIMARY KEY,
  exec_id BIGINT NOT NULL REFERENCES execution(id),
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_log_exec ON execution_log(exec_id, id);