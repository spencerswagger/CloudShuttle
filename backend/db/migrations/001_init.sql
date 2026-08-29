-- 001_init.sql —— 初始表结构
-- 全部使用 IF NOT EXISTS / ADD COLUMN IF NOT EXISTS，对存量库同样安全（首次应用为幂等即装成功）

CREATE TABLE IF NOT EXISTS pipeline (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  spec_json JSONB NOT NULL DEFAULT '{}',
  rev INT NOT NULL DEFAULT 1,
  git_hook_secret TEXT NOT NULL DEFAULT '',   -- git webhook 访问密钥（创建时生成）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE pipeline ADD COLUMN IF NOT EXISTS git_hook_secret TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS pipeline_rev (
  id BIGSERIAL PRIMARY KEY,
  pipeline_id BIGINT NOT NULL REFERENCES pipeline(id),
  rev INT NOT NULL,
  spec_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

CREATE TABLE IF NOT EXISTS execution_node (
  id BIGSERIAL PRIMARY KEY,
  exec_id BIGINT NOT NULL REFERENCES execution(id),
  node_id TEXT NOT NULL,
  step TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  input JSONB,
  output JSONB,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE(exec_id, node_id)
);

CREATE TABLE IF NOT EXISTS webhook_registry (
  id BIGSERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  exec_id BIGINT NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- eci | dingtalk
  secret TEXT NOT NULL DEFAULT '',   -- 每个回调独立的访问密钥
  expires_at TIMESTAMPTZ NOT NULL
);

-- 存量库兼容：补充 secret 列（幂等，重复执行无害）
ALTER TABLE webhook_registry ADD COLUMN IF NOT EXISTS secret TEXT NOT NULL DEFAULT '';
-- 存量库兼容：补充 credential 列，回调更新卡片状态时据此反查机器人凭证刷新 accessToken
ALTER TABLE webhook_registry ADD COLUMN IF NOT EXISTS credential TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS credential (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,          -- docker-registry | s3 | git-token | kubeconfig
  secret_enc TEXT NOT NULL,    -- SM4 加密后的 JSON（AK/SK/账号密码等）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 存量库兼容：credential 表补充 updated_at（updateCredential 依赖）
ALTER TABLE credential ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS exec_image (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  image TEXT NOT NULL,
  category TEXT NOT NULL,
  builtin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);