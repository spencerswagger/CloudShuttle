-- 003_webhook_secret_rename.sql —— 存量库从 git_hook_secret 迁移到 webhook_secret
-- 背景：001 已把建表直接改为 webhook_secret（仅对全新库生效）；已应用过旧版 001/002
--      的存量库 schema_migrations 不会重跑 001，此处做幂等补齐：
--        - 旧列存在、新列不存在 → RENAME（保留列值，不丢已有流水线密钥）
--        - 新列缺失 → 兜底 ADD（全新库 001 已建列则空操作）
--        - 旧列与新列并存（极端）→ RENAME 会失败，故仅当新列缺失才改名
--        - webhook_probe 表：存量库没有则创建（全新库 001 已建则 IF NOT EXISTS 空操作）

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

CREATE TABLE IF NOT EXISTS webhook_probe (
  pipeline_id BIGINT PRIMARY KEY,
  body JSONB NOT NULL,
  http_status INT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);