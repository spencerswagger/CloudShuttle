// approval 节点：只走钉钉企业机器人（dingtalk-corp）的最新版互动卡片（卡片实例 createAndDeliver）。
// 发送 → dingtalkCorpProvider.sendApprovalCard（发人 IM_ROBOT / 发群 IM_GROUP）。
// 生成 token + 独立 secret 落库，回调统一走 /hook/dingtalk/card/:token。
//
// 卡片正文组装（消费同一张扁平变量地图 ctx.environment）：
//  - 用户节点自定义正文（p.message）非空 → 直接作为唯一卡片正文。执行引擎 state.advanceOnce
//    在 stepRun 前已对节点 params 深渲染 ${name}，故 p.message 已是最新替换后的文本，所见即所得。
//  - 空 → 使用内置默认模板，模板占位符为 ${ } 风格（${pipeline_name}/${run_no}/${started_at} 等），
//    用 render(template, ctx.environment) 填充。正文不显示回调 uuid/token。

import { render } from "../engine/variables.js";

// 审批卡片默认模板。${name} 引用扁平变量地图里的执行元信息变量（见 variables.globalKeysOf：
// pipeline_id / pipeline_name / run_no / exec_id / started_at）。未命中的占位符由
// variables.render 原样保留，方便发现变量名拼写错误。
export const APPROVAL_CARD_TEMPLATE =
  `### ✦ 流水线审批卡点\n\n` +
  `| 项 | 内容 |\n|---|---|\n` +
  `| **流水线** | \`\${pipeline_name}\`（执行 #\`\${run_no}\`） |\n` +
  `| **执行 ID** | \`\${exec_id}\` |\n` +
  `| **流水线 ID** | \`\${pipeline_id}\` |\n` +
  `| **发起时间** | \${started_at} |\n\n` +
  `---\n请审核后点击下方按钮完成审批。`;

export const APPROVAL_CARD_DEFAULT_BODY = "请审批该流水线卡点";

// 把扁平环境源（Map 或对象）规整为 values 用的 Map；值统一转字符串，与 variables.render 契合。
function ensureEnvMap(env) {
  if (env instanceof Map) return env;
  const m = new Map();
  if (env && typeof env === "object") {
    for (const [k, v] of Object.entries(env)) m.set(k, String(v));
  }
  return m;
}

// 组装最终卡片正文（所见即所得）：
//  - body 非空 → 直接输出（执行引擎已对 params 深渲染，body 即最终文本）
//  - 空 → 用内置默认模板，以 variables.render 填充 ${pipeline_name} 等环境变量
export function renderApprovalCard({ body, env }) {
  if (body && String(body).trim()) return String(body);
  return render(APPROVAL_CARD_TEMPLATE, ensureEnvMap(env));
}

export function makeApprovalStep({
  dingtalkCorpProvider,
  getCredentialKind,
  getCredentialSecrets,
  genToken,
  controlPlaneBase,
}) {
  return async function approvalStep(node, ctx) {
    const p = node.params;
    if (!p.robot) throw new Error("approval node requires params.robot = 钉钉企业机器人凭证名");
    const kind = await getCredentialKind(p.robot);
    if (kind !== "dingtalk-corp") {
      throw new Error(`审批节点只支持钉钉企业机器人(dingtalk-corp)，当前凭证「${p.robot}」类型为「${kind || "未知"}」`);
    }
    const token = genToken();
    const secret = genToken(); // 每个回调独立密钥，落库并在回拨时校验
    const base = typeof controlPlaneBase === "function" ? controlPlaneBase(ctx) : controlPlaneBase;
    const callbackUrl = `${base}/hook/dingtalk/card/${token}?secret=${secret}`;
    const openIds = Array.isArray(p?.target?.openIds) ? p.target.openIds
      : String(p?.target?.openIds ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    console.log(
      `[approval] pipeline=${ctx.execId} node=${node.id} robot=${p.robot} kind=${kind} ` +
      `target.openIds=[${openIds.join(",")}] callback=${callbackUrl}`
    );
    // 组装卡片正文：消费 ctx.environment（扁平变量地图）。p.message 已由执行引擎渲染，所见即所得；
    // 空则用默认模板，以同一张地图填充 ${pipeline_name}/${run_no} 等变量。
    const md = renderApprovalCard({ body: p.message, env: ctx.environment });
    console.log(`[approval] exec=${ctx.execId} node=${node.id} 卡片正文已组装：\n${md}`);
    const corp = await getCredentialSecrets(p.robot);
    console.log(
      `[approval] pipeline=${ctx.execId} node=${node.id} robot=${p.robot} ` +
      `corp.robotCode=${corp?.robotCode} corp.cardTemplateId=${corp?.cardTemplateId} corp.routeKey=${corp?.cardCallbackRouteKey}`
    );
    await dingtalkCorpProvider.sendApprovalCard({
      robot: corp, target: p.target,
      approver: p.approverUid, text: md,
      callbackUrl, token,
    });
    console.log(`[approval] ✔ 审批卡片已成功投递：token=${token} exec=${ctx.execId} node=${node.id}，开始登记回调凭证等待回拨`);
    await ctx.recordRegistry({ kind: "dingtalk", token, secret, credential: p.robot, execId: ctx.execId, nodeId: node.id });
    console.log(`[approval] ✔ 回调凭证已登记：token=${token} secret 已独立生成，回调统一走 /hook/dingtalk/card`);
    return { kind: "wait", ref: token };
  };
}