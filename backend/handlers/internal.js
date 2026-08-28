// backend/handlers/internal.js —— /_/hook/* 内部回调（ECI 容器结束后续跑）
// 仅允许内网来源（handler 层按 IP 拦截），此处再校验 token+secret 双因子。
import { pool } from "../db/pg.js";
import { safeEqual } from "../security.js";

// 按 token 取登记记录；secret 与 exec_id/node_id 以库内为准，防 URL 篡改
export async function lookupRegistry({ token, kind }) {
  const { rows: r } = await pool.query(
    `SELECT exec_id, node_id, secret FROM webhook_registry
      WHERE token=$1 AND kind=$2 AND expires_at > now()`,
    [token, kind]
  );
  return r[0] ?? null;
}

// 校验 token + secret；通过则返回库内的 exec_id / node_id
export async function validateCallback({ token, secret, kind }) {
  const row = await lookupRegistry({ token, kind });
  if (!row) return { ok: false };
  if (!safeEqual(row.secret, secret)) return { ok: false };
  return { ok: true, execId: Number(row.exec_id), nodeId: row.node_id };
}

export async function eciDone(orchestrator, { token, secret, result }) {
  const v = await validateCallback({ token, secret, kind: "eci" });
  if (!v.ok) return { status: 401, body: { ok: false, error: "invalid callback" } };
  await orchestrator.onEciDone({ execId: v.execId, nodeId: v.nodeId });
  return { status: 200, body: { ok: true } };
}

export async function eciFail(orchestrator, { token, secret, reason }) {
  const v = await validateCallback({ token, secret, kind: "eci" });
  if (!v.ok) return { status: 401, body: { ok: false, error: "invalid callback" } };
  await orchestrator.onEciFail?.({ execId: v.execId, nodeId: v.nodeId, reason });
  return { status: 200, body: { ok: true } };
}