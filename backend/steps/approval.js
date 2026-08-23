export function makeApprovalStep({ dingtalkProvider, genToken, controlPlaneBase }) {
  return async function approvalStep(node, ctx) {
    const p = node.params;
    if (!p.robot) throw new Error("approval node requires params.robot = 钉钉机器人凭证名");
    const token = genToken();
    const base = typeof controlPlaneBase === "function" ? controlPlaneBase(ctx) : controlPlaneBase;
    // 卡片按钮带 execId/nodeId，审批点击→浏览器回拨时不需要反查，直接用 query 续跑
    const callbackUrl = `${base}/hook/dingtalk/${token}?execId=${ctx.execId}&nodeId=${encodeURIComponent(node.id)}`;
    await dingtalkProvider.sendApprovalCard({
      robot: p.robot, approver: p.approverUid, text: p.message ?? "请审批该流水线卡点",
      callbackUrl, token,
    });
    await ctx.recordRegistry({ kind: "dingtalk", token, execId: ctx.execId, nodeId: node.id });
    return { kind: "wait", ref: token };
  };
}