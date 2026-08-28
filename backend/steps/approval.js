export function makeApprovalStep({ dingtalkProvider, genToken, controlPlaneBase }) {
  return async function approvalStep(node, ctx) {
    const p = node.params;
    if (!p.robot) throw new Error("approval node requires params.robot = 钉钉机器人凭证名");
    const token = genToken();
    const secret = genToken(); // 每个回调独立密钥，落库并在回拨时校验
    const base = typeof controlPlaneBase === "function" ? controlPlaneBase(ctx) : controlPlaneBase;
    // 卡片按钮带 secret/execId/nodeId：服务端生成并校验，用户不可预见
    const callbackUrl = `${base}/hook/dingtalk/${token}?secret=${secret}&execId=${ctx.execId}&nodeId=${encodeURIComponent(node.id)}`;
    await dingtalkProvider.sendApprovalCard({
      robot: p.robot, approver: p.approverUid, text: p.message ?? "请审批该流水线卡点",
      callbackUrl, token,
    });
    await ctx.recordRegistry({ kind: "dingtalk", token, secret, execId: ctx.execId, nodeId: node.id });
    return { kind: "wait", ref: token };
  };
}