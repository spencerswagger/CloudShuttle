// backend/handlers/hook.js —— /hook/* 外部回调（webhook 触发 / 钉钉审批）
// 两者的鉴权口径不同，勿混：
//   - webhook 触发：只支持 URL query 携带 ?secret=（能力边界：不支持签名头/HMAC，
//     请求体必须是 Content-Type: application/json）；密钥按管道独立、创建时生成，未配置一律拒绝。
//   - 钉钉审批回调：exec_id/node_id 一律以库内 webhook_registry 登记为准，防 URL 篡改。
//     新版互动卡片走 callbackRouteKey 回调，回传体不带 secret（也不再拼在 URL 上），
//     以随机 outTrackId 中的 token 为唯一凭据；secret 只在旧版 path/query 回调携带时才校验。
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
  console.log(
    `[dingtalk-card] cb tokenFromPath=${token ?? "-"} tokenUsed=${token_ ?? "-"} ` +
    `secret=${secret ? "present" : "none"} decision=${decision ?? "-"} ` +
    `outTrackId=${body?.outTrackId ?? "-"} body=${JSON.stringify(body ?? {}).slice(0, 600)}`
  );
  const row = await lookup({ token: token_, kind: "dingtalk" });
  if (!row) {
    console.warn(`[dingtalk-card] LOOKUP-FAIL token=${token_ ?? "-"} kind=dingtalk`);
    return { status: 403, body: { ok: false, code: "FORBIDDEN", message: "审批回调凭证无效" } };
  }
  // 旧版 path+query 携带 secret 时校验；新版 routeKey 回传体无 secret，以随机 outTrackId 中的 token 为凭据
  if (secret && !safeEqual(row.secret, secret)) {
    console.warn(`[dingtalk-card] SECRET-MISMATCH token=${token_} (expected secret present but differs)`);
    return { status: 403, body: { ok: false, code: "FORBIDDEN", message: "审批回调凭证无效" } };
  }
  const decision_ = extractDecision(body, decision);
  console.log(
    `[dingtalk-card] OK exec=${row.exec_id} node=${row.node_id} ` +
    `decision=${decision_ ?? "(none)"} -> ${decision_ === "reject" ? "REJECT" : "APPROVE"}`
  );
  const agreed = decision_ === "reject" ? false : true;
  const out = await orchestrator.onApproval({
    execId: Number(row.exec_id),
    nodeId: row.node_id,
    decision: agreed ? "approve" : "reject",
  });
  console.log(`[dingtalk-card] advance done exec=${row.exec_id} node=${row.node_id} out=${JSON.stringify(out ?? {})}`);
  // 审批已推进，把卡片状态更新为已同意/已拒绝。必须 await 后再响应：
  // FC 在请求返回后冻结容器，fire-and-forget 的更新会挂起直到下次唤起（用户表现为要点两次才显示已同意）。
  // 更新失败仅告警，不影响审批推进结果。
  if (typeof updateCard === "function") {
    try {
      await updateCard({ credential: row.credential, token: token_, status: agreed ? "agree" : "reject" });
    } catch (e) {
      console.warn("[dingtalk] update card status failed", e?.message);
    }
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

// 归一回调决策：兼容三种回调来源的按钮回传参数结构，允许 action=agree/reject 与 decision 两种命名。
//   A) 新版 createAndDeliver 卡片实例回调：content = JSON 字符串 {cardPrivateData:{actionIds,params}}
//   B) 普通版 StandardCard 回传：value = JSON 字符串，params 在 value.params 或 value.cardPrivateData.params
//   C) 老版 RETURN_BACK：body.content 为对象 {callbackMsg:{type,content:return_data}}
//   最后回退到 query decision。
export function extractDecision(body, queryDecision) {
  if (body && typeof body.content === "string") {
    const d = extractFromCardPrivateData(body.content);
    if (d) return d;
  }
  if (body && typeof body.value === "string") {
    const d = extractFromCardPrivateData(body.value);
    if (d) return d;
    try {
      const j = JSON.parse(body.value);
      const p = j?.params ?? {};
      if (p.action === "agree" || p.action === "reject") return p.action;
      if (p.decision === "approve" || p.decision === "reject") return p.decision;
    } catch { /* 忽略解析失败 */ }
  }
  const inner = body?.content?.callbackMsg?.content;
  if (typeof inner === "string") {
    try { const j = JSON.parse(inner); if (j.decision === "approve" || j.decision === "reject") return j.decision; } catch { /* 忽略 */ }
  } else if (inner && (inner.decision === "approve" || inner.decision === "reject")) {
    return inner.decision;
  }
  return queryDecision;
}

// 从 cardPrivateData JSON 中提取决策：优先 params.action（agree/reject），其次 params.decision，最后按按钮 id 兜底
function extractFromCardPrivateData(str) {
  let j;
  try { j = JSON.parse(str); } catch { return null; }
  const p = j?.cardPrivateData?.params ?? {};
  if (p.action === "agree" || p.action === "reject") return p.action;
  if (p.decision === "approve" || p.decision === "reject") return p.decision;
  const ids = Array.isArray(j?.cardPrivateData?.actionIds) ? j.cardPrivateData.actionIds : [];
  const map = { approve: "approve", reject: "reject", act_ok: "agree", act_no: "reject", agree: "agree" };
  for (const id of ids) if (map[id]) return map[id];
  return null;
}

// 更新已投递卡片的模板状态变量（status=agree/reject），让卡片从「待审批」变为「已同意/已拒绝」
export async function updateDeliveredCard({ credential, token, status, getCredentialSecrets, getAccessToken, httpClient }) {
  if (!credential) {
    console.warn(`[dingtalk] 更新审批卡片状态已跳过：该回调记录无 credential，无法刷新 accessToken token=${token ?? "-"}`);
    return; // 老库记录无 credential，无从刷新 accessToken，直接跳过
  }
  const robot = await getCredentialSecrets(credential);
  const accessToken = await getAccessToken(robot);
  console.log(`[dingtalk] 正在更新审批卡片状态：token=${token} status=${status} → 卡片将变为「${status === "agree" ? "已同意" : "已拒绝"}」`);
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
  console.log(`[dingtalk] ✔ 审批卡片状态更新成功：token=${token} status=${status}`);
}

// 按管道名解析 pipeline，返回 { pipelineId, webhookSecret }（轻量查询 webhook 触发定位）
export async function resolvePipelineByName(name) {
  const { rows: r } = await pool.query(`SELECT id, webhook_secret FROM pipeline WHERE name=$1`, [name]);
  if (!r[0]) throw new Error(`pipeline not found: ${name}`);
  return { pipelineId: r[0].id, webhookSecret: r[0].webhook_secret ?? "" };
}

// 探针落库上限：body 序列化后超过 256KB 只保留前 100KB 预览，避免第三方整包投递撑爆库表。
const PROBE_MAX_BYTES = 256 * 1024;
const PROBE_PREVIEW_CHARS = 100 * 1024;

// 探针 body 落库前的归一（纯函数，可单测）：JSON 序列化 → 超限时存
// {"_truncated":true,"preview":"<前 100KB 原文>"}；无法序列化（循环引用、BigInt 等）存占位对象。
export function probeBodyJson(body) {
  let json;
  try {
    json = JSON.stringify(body ?? {});
    // body 为函数/symbol 时 JSON.stringify 返回 undefined
    if (typeof json !== "string") json = "{}";
  } catch {
    return JSON.stringify({ _unserializable: true });
  }
  if (Buffer.byteLength(json, "utf8") <= PROBE_MAX_BYTES) return json;
  return JSON.stringify({ _truncated: true, preview: json.slice(0, PROBE_PREVIEW_CHARS) });
}

// 调试探针的 SQL 与参数（纯函数，可单测）：每个管道只保留最近一次投递的 body + 处理结果，
// 处理结束后一次性 UPSERT（P1-3：只记 body 会让用户看到「已收到」却在 401/500 上误判链路已通）。
export function probeStatement(pipelineId, body, httpStatus = null) {
  return {
    sql: `INSERT INTO webhook_probe(pipeline_id, body, http_status) VALUES($1,$2::jsonb,$3)
          ON CONFLICT (pipeline_id) DO UPDATE SET body=EXCLUDED.body, http_status=EXCLUDED.http_status, received_at=now()`,
    params: [pipelineId, probeBodyJson(body), httpStatus],
  };
}

// 记录本次 webhook 投递的原始 body 与最终处理结果（http_status：200/401/503/500），
// 供 GET /api/pipelines/:id/webhook-probe 排障查看。
// 任何异常只告警，绝不影响 webhook 主流程（探针是辅助，不是前提）；query 可注入便于单测。
export async function recordProbe(
  pipelineId, body, httpStatus = null,
  query = (sql, params) => pool.query(sql, params)
) {
  try {
    const { sql, params } = probeStatement(pipelineId, body, httpStatus);
    await query(sql, params);
  } catch (err) {
    console.warn(`[webhook] 探针写入失败 pipeline=${pipelineId}: ${err?.message ?? err}`);
  }
}

// webhook 触发：校验该管道独立的访问密钥（创建时生成、落库），未配置则拒绝；
// 鉴权通过后转交 run（由控制面注入，内部完成 spec 读取、webhook 变量装配与编排执行）。
// run 入参 { pipelineId, payload, authority }，返回 orchestrator.run 的结果（含 waiting）。
// resolve / probe 可注入（默认走库），便于对密钥校验与探针记录点做单测。
// 探针在「处理结束后」记录一次，并带上本次处理结果 http_status；管道未命中（resolve 抛错）
// 时无法定位 pipeline_id，不记录。
export async function webhook(
  run,
  { pipelineName, payload, authority, secret, resolve = resolvePipelineByName, probe = recordProbe }
) {
  const { pipelineId, webhookSecret } = await resolve(pipelineName);
  let status;
  try {
    if (!webhookSecret) {
      status = 503;
      return { status, body: { ok: false, code: "HOOK_NOT_CONFIGURED", message: "该管道的 webhook 密钥未配置" } };
    }
    if (!safeEqual(webhookSecret, secret)) {
      status = 401;
      return { status, body: { ok: false, code: "UNAUTHORIZED", message: "webhook 密钥错误" } };
    }
    const out = await run({ pipelineId, payload: payload ?? {}, authority });
    status = 200;
    return { status, body: { ok: true, waiting: out?.waiting ?? null } };
  } finally {
    // run 抛错（编排/入库失败）时 status 仍为空，按 500 记录；probe 自身不会抛。
    await probe(pipelineId, payload ?? {}, status ?? 500);
  }
}

// 钉钉审批卡片按钮回调请见 dingtalkCardCb（上方），此处仅保留 webhook 触发逻辑