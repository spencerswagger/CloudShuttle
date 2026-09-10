-- 005_execution_log.sql —— 调度日志：非节点执行日志，记录流水线调度的完整过程（幂等）
CREATE TABLE IF NOT EXISTS execution_log (
  id BIGSERIAL PRIMARY KEY,
  exec_id BIGINT NOT NULL REFERENCES execution(id),
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_log_exec ON execution_log(exec_id, id);