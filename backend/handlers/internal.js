// backend/handlers/internal.js —— /_/hook/* 内部回调（ECI 容器结束后续跑）
// 仅允许内网来源（handler 层按 IP 拦截），此处再校验 token+secret 双因子。
import { pool } from "../db/pg.js";
import { safeEqual } from "../security.js";

// 按 token 取登记记录；secret 与 exec_id/node_id 以库内为准，防 URL 篡改。
// kinds 可传数组（如 eci/job 共用同一回调端点）。
export async function lookupRegistry({ token, kind, kinds }) {
  const list = kind ? [kind] : Array.isArray(kinds) && kinds.length ? kinds : null;
  let sql;
  let params;
  if (list) {
    sql = `SELECT exec_id, node_id, secret, credential FROM webhook_registry
      WHERE token=$1 AND kind = ANY($2::text[]) AND expires_at > now()`;
    params = [token, list];
  } else {
    sql = `SELECT exec_id, node_id, secret, credential FROM webhook_registry
      WHERE token=$1 AND expires_at > now()`;
    params = [token];
  }
  const { rows: r } = await pool.query(sql, params);
  return r[0] ?? null;
}

// 校验 token + secret；通过则返回库内的 exec_id / node_id
export async function validateCallback({ token, secret, kind, kinds }) {
  const row = await lookupRegistry({ token, kind, kinds });
  if (!row) return { ok: false };
  if (!safeEqual(row.secret, secret)) return { ok: false };
  return { ok: true, execId: Number(row.exec_id), nodeId: row.node_id };
}

export async function eciDone(orchestrator, { token, secret, result }) {
  const v = await validateCallback({ token, secret, kinds: ["job"] });
  if (!v.ok) return { status: 401, body: { ok: false, error: "invalid callback" } };
  // 诊断：打印回调收到的 output/logs 长度与日志原文样本，定位「succeeded 但 logs/output 为空」
  const outRaw = String(result?.output ?? "");
  const logsRaw = String(result?.logs ?? "");
  const sample = (b64) => {
    try { return Buffer.from(String(b64).slice(0, 400), "base64").toString("utf8").slice(0, 200); }
    catch { return ""; }
  };
  console.log(
    `[eciDone] exec=${v.execId} node=${v.nodeId} outputLen=${outRaw.length} logsLen=${logsRaw.length} ` +
    `outputSample=${JSON.stringify(sample(outRaw))} logsSample=${JSON.stringify(sample(logsRaw))}`
  );
  // 外部副作用（解析/写库/推进）必须 await 完成后再响应，FC 容器冻结下 fire-and-forget 会丢
  await orchestrator.onEciDone({
    execId: v.execId, nodeId: v.nodeId,
    output: outRaw, logs: logsRaw,
  });
  return { status: 200, body: { ok: true } };
}

export async function eciFail(orchestrator, { token, secret, reason }) {
  const v = await validateCallback({ token, secret, kinds: ["job"] });
  if (!v.ok) return { status: 401, body: { ok: false, error: "invalid callback" } };
  await orchestrator.onEciFail?.({ execId: v.execId, nodeId: v.nodeId, reason });
  return { status: 200, body: { ok: true } };
}