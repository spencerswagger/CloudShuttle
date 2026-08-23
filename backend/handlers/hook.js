// backend/handlers/hook.js —— /hook/* 外部回调（git webhook / 钉钉审批）
// 与 orchestrator 的接线保持真实但简单：gitWebhook 直接驱动 onGitWebhook。
// 钉钉回调依赖真实验签与 orchestrator 审批分支，联调阶段用真实实现。
import { pool } from "../db/pg.js";

// 按管道名解析 pipeline，返回 { pipelineId }（轻量查询 webhook 触发定位）
export async function resolvePipelineByName(name) {
  const { rows: r } = await pool.query(`SELECT id FROM pipeline WHERE name=$1`, [name]);
  if (!r[0]) throw new Error(`pipeline not found: ${name}`);
  return { pipelineId: r[0].id };
}

export async function gitWebhook(orchestrator, { pipelineName, payload, authority }) {
  const { pipelineId } = await resolvePipelineByName(pipelineName);
  const out = await orchestrator.onGitWebhook({ pipelineId, trigger: payload ?? {}, authority });
  return { status: 200, body: { ok: true, waiting: out?.waiting ?? null } };
}

// 钉钉审批卡片按钮回调：卡片链接已带 token/execId/nodeId/decision，直接续跑
export async function dingtalkCb(orchestrator, { token, execId, nodeId, decision }) {
  void token;
  if (!execId || !nodeId) throw new Error("missing execId/nodeId in approval callback");
  return orchestrator.onApproval({ execId, nodeId, decision });
}