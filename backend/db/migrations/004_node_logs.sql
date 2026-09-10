-- 004_node_logs.sql —— execution_node 增加 logs 列，存脚本 stdout/stderr 回传内容（幂等）
ALTER TABLE execution_node ADD COLUMN IF NOT EXISTS logs TEXT;