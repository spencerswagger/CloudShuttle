// backend/handlers/hook.js —— /hook/* 外部回调（git webhook / 钉钉审批）
// git 与钉钉回调均需携带访问密钥；钉钉回调的 exec_id/node_id 以库内登记为准，防篡改。
import { pool } from "../db/pg.js";
import { safeEqual } from "../security.js";

// 钉钉审批卡片按钮回调（统一入口 /hook/dingtalk/card/:token）
// 兼容三种来源：
//   - 群（RETURN_BACK）：钉钉服务器 POST，decision 在 body.content.callbackMsg.content
//   - 群（新版 createAndDeliver）：回调走注册的 callbackRouteKey，token 在 body.outTrackId（前缀 cloudshuttle_）
//   - 人/webhook（URL）：GET，decision 在 query
// exec_id/node_id 一律以库内登记为准，防篡改。
export async function dingtalkCardCb(orchestrator, { token, secret, decision, body, lookup }) {
  const token_ = token || extractTokenFromOutTrack(body?.outTrackId);
  const row = await lookup({ token: token_, kind: "dingtalk" });
  if (!row) return { status: 403, body: { ok: false, code: "FORBIDDEN", message: "审批回调凭证无效" } };
  // 旧版 path+query 携带 secret 时校验；新版 routeKey 回传体无 secret，以随机 outTrackId 中的 token 为凭据
  if (secret && !safeEqual(row.secret, secret)) {
    return { status: 403, body: { ok: false, code: "FORBIDDEN", message: "审批回调凭证无效" } };
  }
  const decision_ = extractDecision(body, decision);
  const out = await orchestrator.onApproval({
    execId: Number(row.exec_id),
    nodeId: row.node_id,
    decision: decision_ === "reject" ? "reject" : "approve",
  });
  return { status: 200, body: out ?? {} };
}

// 从新版回调体 outTrackId（形如 cloudshuttle_<token>）提取 token
export function extractTokenFromOutTrack(outTrackId) {
  if (typeof outTrackId === "string" && outTrackId.startsWith("cloudshuttle_")) {
    const t = outTrackId.slice("cloudshuttle_".length);
    if (t) return t;
  }
  return null;
}

// 归一决策：优先取「回传请求」按钮回传的 decision，其次用 query
// 兼容两种来源结构：
//   - 普通版 StandardCard 回传：body.value 为 JSON 字符串，内含 params（按钮回传参数）
//   - 老版 RETURN_BACK：body.content.callbackMsg.content 为 return_data JSON
export function extractDecision(body, queryDecision) {
  // 普通版 StandardCard：「回传请求」→ body.value = "{\"cardPrivateData\":{...},\"params\":{\"decision\":\"...\"}}"
  if (body && typeof body.value === "string") {
    try {
      const j = JSON.parse(body.value);
      if (j?.params?.decision) return j.params.decision;
      // 兜底：若钉钉未回传 params，则按当前点击按钮 id（cardPrivateData.actionIds）推断决策
      const ids = Array.isArray(j?.cardPrivateData?.actionIds) ? j.cardPrivateData.actionIds : [];
      const map = { approve: "approve", reject: "reject", act_ok: "approve", act_no: "reject" };
      for (const id of ids) if (map[id]) return map[id];
    } catch { /* 忽略解析失败 */ }
  }
  const cb = body?.content?.callbackMsg;
  if (cb?.type === "RETURN_BACK") {
    const inner = cb.content;
    if (typeof inner === "string") {
      try { const j = JSON.parse(inner); if (j && j.decision) return j.decision; } catch { /* 忽略 */ }
    } else if (inner && inner.decision) {
      return inner.decision;
    }
  }
  return queryDecision;
}

// 按管道名解析 pipeline，返回 { pipelineId, gitHookSecret }（轻量查询 webhook 触发定位）
export async function resolvePipelineByName(name) {
  const { rows: r } = await pool.query(`SELECT id, git_hook_secret FROM pipeline WHERE name=$1`, [name]);
  if (!r[0]) throw new Error(`pipeline not found: ${name}`);
  return { pipelineId: r[0].id, gitHookSecret: r[0].git_hook_secret ?? "" };
}

// git webhook：校验该仓库独立的访问密钥（创建时生成、落库），未配置则拒绝
export async function gitWebhook(orchestrator, { pipelineName, payload, authority, secret }) {
  const { pipelineId, gitHookSecret } = await resolvePipelineByName(pipelineName);
  if (!gitHookSecret) {
    return { status: 503, body: { ok: false, code: "HOOK_NOT_CONFIGURED", message: "该管道的 git hook 密钥未配置" } };
  }
  if (!safeEqual(gitHookSecret, secret)) {
    return { status: 401, body: { ok: false, code: "UNAUTHORIZED", message: "git webhook 密钥错误" } };
  }
  const out = await orchestrator.onGitWebhook({ pipelineId, trigger: payload ?? {}, authority });
  return { status: 200, body: { ok: true, waiting: out?.waiting ?? null } };
}

// 钉钉审批卡片按钮回调请见 dingtalkCardCb（上方），此处仅保留 git 逻辑