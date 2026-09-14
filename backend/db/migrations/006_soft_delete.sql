-- 006_soft_delete.sql —— 实体软删除：pipeline/credential/exec_image 增加 deleted_at 标记列，
-- 删除接口由物理 DELETE 改为 UPDATE deleted_at=now()，历史执行/日志/rev 全量保留。
--
-- name 唯一约束同步改造：原 UNIQUE 约束（自动命名 {table}_name_key）改为「仅未删除行唯一」
-- 的部分唯一索引，保证删除后可以重建同名实体，且不影响存量库（DO 块判断约束存在才 DROP）。
-- 全部幂等：重复应用安全。

ALTER TABLE pipeline   ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE credential  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE exec_image  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_name_key') THEN
    ALTER TABLE pipeline DROP CONSTRAINT pipeline_name_key;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credential_name_key') THEN
    ALTER TABLE credential DROP CONSTRAINT credential_name_key;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exec_image_name_key') THEN
    ALTER TABLE exec_image DROP CONSTRAINT exec_image_name_key;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_name_active
  ON pipeline(name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_credential_name_active
  ON credential(name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_exec_image_name_active
  ON exec_image(name) WHERE deleted_at IS NULL;
