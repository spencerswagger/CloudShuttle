// approval 节点：只走钉钉企业机器人（dingtalk-corp）的最新版互动卡片（卡片实例 createAndDeliver）。
// 发送 → dingtalkCorpProvider.sendApprovalCard（发人 IM_ROBOT / 发群 IM_GROUP）。
// 生成 token + 独立 secret 落库，回调统一走 /hook/dingtalk/card/:token。
//
// 卡片正文组装：提供默认模板，并内置一批占位符（{{pipeline}}/{{runNo}}/{{trigger}}/{{startedAt}}/
// {{execId}}/{{pipelineId}}/{{node}} 与 {{body}}）供节点自定义。正文不显示回调 uuid/token。

// 审批卡片默认模板。{{body}} 为用户自定义正文（可再含占位符）；其余占位符运行时填充。
export const APPROVAL_CARD_TEMPLATE =
  `### ✦ 流水线审批卡点\n\n` +
  `| 项 | 内容 |\n|---|---|\n` +
  `| **流水线** | \`{{ pipeline }}\`（执行 #{{ runNo }}） |\n` +
  `| **触发方式** | {{ trigger }} |\n` +
  `| **发起时间** | {{ startedAt }} |\n\n` +
  `{{ body }}\n\n` +
  `---\n请审核后点击下方按钮完成审批。`;

export const APPROVAL_CARD_DEFAULT_BODY = "请审批该流水线卡点";

// 替换 {{ name }} 占位符；未命中的占位符原样保留，方便发现拼写错误
function fillVars(text, vars) {
  return String(text ?? "").replace(/\{\{\s*([a-zA-Z][\w]*)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// 组装最终卡片正文：
//  - 用户节点自定义正文非空 → 直接作为唯一卡片正文（占位符填充），不再套外层模板，所见即所得
//  - 空 → 使用内置默认模板（含流水线/执行编号/触发方式等元信息）
export function renderApprovalCard({ body, meta, nodeId }) {
  const vars = {
    pipeline: meta?.pipeline ?? "",
    runNo: meta?.runNo ?? "-",
    trigger: meta?.trigger ?? "manual",
    startedAt: meta?.startedAt ?? "-",
    execId: meta?.execId ?? "",
    pipelineId: meta?.pipelineId ?? "",
    node: meta?.node ?? nodeId ?? "",
  };
  if (body && String(body).trim()) return fillVars(body, vars);
  return fillVars(APPROVAL_CARD_TEMPLATE, { ...vars, body: fillVars(APPROVAL_CARD_DEFAULT_BODY, vars) });
}

export function makeApprovalStep({
  dingtalkCorpProvider,
  getCredentialKind,
  getCredentialSecrets,
  genToken,
  controlPlaneBase,
  loadExecMeta,
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
    // 组装卡片正文：默认模板 + 节点自定义正文 + 流水线/执行元信息填充（不暴露 uuid）
    const meta = (await loadExecMeta?.({
      execId: ctx.execId, pipelineId: ctx.spec?.pipelineId, nodeId: node.id,
    })) ?? { execId: ctx.execId, pipelineId: ctx.spec?.pipelineId, node: node.id };
    const md = renderApprovalCard({ body: p.message, meta, nodeId: node.id });
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