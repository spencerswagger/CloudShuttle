// backend/handlers/hook.js —— /hook/* 外部回调（git webhook / 钉钉审批）
// git 与钉钉回调均需携带访问密钥；钉钉回调的 exec_id/node_id 以库内登记为准，防篡改。
import { pool } from "../db/pg.js";
import { safeEqual } from "../security.js";

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

// 钉钉审批卡片按钮回调：token+secret 双因子校验，exec_id/node_id 取库内值续跑
export async function dingtalkCb(orchestrator, { token, secret, decision, lookup }) {
  const row = await lookup({ token, kind: "dingtalk" });
  if (!row) return { status: 401, body: { ok: false, code: "AUTH_REQUIRED", message: "无效的回调凭证" } };
  if (!safeEqual(row.secret, secret)) {
    return { status: 403, body: { ok: false, code: "FORBIDDEN", message: "回调密钥不正确" } };
  }
  const out = await orchestrator.onApproval({
    execId: Number(row.exec_id),
    nodeId: row.node_id,
    decision: decision === "reject" ? "reject" : "approve",
  });
  return { status: 200, body: out ?? {} };
}