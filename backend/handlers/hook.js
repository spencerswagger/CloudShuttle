// backend/handlers/hook.js —— /hook/* 外部回调（git webhook / 钉钉审批）
// git 与钉钉回调均需携带访问密钥；钉钉回调的 exec_id/node_id 以库内登记为准，防篡改。
import { pool } from "../db/pg.js";
import { safeEqual } from "../security.js";

const DING_BASE = "https://api.dingtalk.com";

// 钉钉审批卡片按钮回调（统一入口 /hook/dingtalk/card/:token）
// 兼容三种来源：
//   - 群（RETURN_BACK）：钉钉服务器 POST，decision 在 body.content.callbackMsg.content
//   - 群（新版 createAndDeliver）：回调走注册的 callbackRouteKey，token 在 body.outTrackId（前缀 cloudshuttle_），
//     决策在 body.value.params.action（agree/reject）；审批推进后回调 updateCard 把模板 status 变量更新为 agree/reject
//   - 人/webhook（URL）：GET，decision 在 query
// exec_id/node_id 一律以库内登记为准，防篡改。
export async function dingtalkCardCb(orchestrator, { token, secret, decision, body, lookup, updateCard }) {
  const token_ = token || extractTokenFromOutTrack(body?.outTrackId);
  const row = await lookup({ token: token_, kind: "dingtalk" });
  if (!row) return { status: 403, body: { ok: false, code: "FORBIDDEN", message: "审批回调凭证无效" } };
  // 旧版 path+query 携带 secret 时校验；新版 routeKey 回传体无 secret，以随机 outTrackId 中的 token 为凭据
  if (secret && !safeEqual(row.secret, secret)) {
    return { status: 403, body: { ok: false, code: "FORBIDDEN", message: "审批回调凭证无效" } };
  }
  const decision_ = extractDecision(body, decision);
  const agreed = decision_ === "reject" ? false : true;
  const out = await orchestrator.onApproval({
    execId: Number(row.exec_id),
    nodeId: row.node_id,
    decision: agreed ? "approve" : "reject",
  });
  // 审批已推进，异步把卡片状态更新为已同意/已拒绝（失败不影响审批结果）
  if (typeof updateCard === "function") {
    updateCard({ credential: row.credential, token: token_, status: agreed ? "agree" : "reject" }).catch((e) => {
      console.warn("[dingtalk] update card status failed", e?.message);
    });
  }
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

// 归一回调决策：优先取按钮「回传参数」的 action（accept/reject 命名的模板按钮），其次 decision，最后 query。
// 兼容 TVORG 结构（官方回传：body.value 为 JSON 字符串，内含 params）与老版 RETURN_BACK。
export function extractDecision(body, queryDecision) {
  if (body && typeof body.value === "string") {
    try {
      const j = JSON.parse(body.value);
      const p = j?.params ?? {};
      if (p.action === "agree" || p.action === "reject") return p.action;
      if (p.decision === "approve" || p.decision === "reject") return p.decision;
      // 兜底：按当前点击按钮 id（cardPrivateData.actionIds）推断决策
      const ids = Array.isArray(j?.cardPrivateData?.actionIds) ? j.cardPrivateData.actionIds : [];
      const map = { approve: "approve", reject: "reject", act_ok: "agree", act_no: "reject", agree: "agree" };
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

// 更新已投递卡片的模板状态变量（status=agree/reject），让卡片从「待审批」变为「已同意/已拒绝」
export async function updateDeliveredCard({ credential, token, status, getCredentialSecrets, getAccessToken, httpClient }) {
  if (!credential) return; // 老库记录无 credential，无从刷新 accessToken，直接跳过
  const robot = await getCredentialSecrets(credential);
  const accessToken = await getAccessToken(robot);
  await httpClient.put(
    `${DING_BASE}/v1.0/card/instances`,
    {
      outTrackId: `cloudshuttle_${token}`,
      cardData: { cardParamMap: { status } },
      cardUpdateOptions: { updateCardDataByKey: true },
      userIdType: 1,
    },
    { headers: { "x-acs-dingtalk-access-token": accessToken, "content-type": "application/json" } }
  );
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