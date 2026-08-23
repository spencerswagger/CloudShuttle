// backend/handlers/internal.js —— /_/hook/* 内部回调（ECI 容器结束后续跑）
// 与 orchestrator 的接线保持真实但简单：eciDone 校验 token 后驱动 onEciDone。
import { pool } from "../db/pg.js";

// 轻量校验回调 token 是否已登记（真实查询 webhook_registry）
export async function validateToken({ token, execId, nodeId, kind }) {
  const { rows: r } = await pool.query(
    `SELECT 1 FROM webhook_registry
      WHERE token=$1 AND exec_id=$2 AND ($3::text IS NULL OR node_id=$3) AND kind=$4`,
    [token, execId, nodeId ?? null, kind]
  );
  return r.length > 0;
}

export async function eciDone(orchestrator, { execId, nodeId, token, result }) {
  const ok = await validateToken({ token, execId, nodeId, kind: "eci" });
  if (!ok) return { status: 401, body: { ok: false, error: "invalid token" } };
  await orchestrator.onEciDone({ execId, nodeId });
  return { status: 200, body: { ok: true } };
}

export async function eciFail(orchestrator, { execId, nodeId, token, reason }) {
  // 联调阶段用真实实现：标记失败节点并写执行结果
  void orchestrator; void execId; void nodeId; void token; void reason;
  return { status: 200, body: { ok: true, note: "eciFail wired at integration" } };
}