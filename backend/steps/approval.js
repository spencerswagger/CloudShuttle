// approval 节点：根据所选机器人凭证类型分派发送
//   - dingtalk-robot（webhook）  → dingtalkProvider（actionCard）
//   - dingtalk-corp（企业应用）   → dingtalkCorpProvider（交互卡片，发群/发人）
// 两种都生成 token + 独立 secret 落库，回调统一走 /hook/dingtalk/card/:token
export function makeApprovalStep({
  dingtalkProvider,
  dingtalkCorpProvider,
  getCredentialKind,
  getCredentialSecrets,
  genToken,
  controlPlaneBase,
}) {
  return async function approvalStep(node, ctx) {
    const p = node.params;
    if (!p.robot) throw new Error("approval node requires params.robot = 钉钉机器人凭证名");
    const token = genToken();
    const secret = genToken(); // 每个回调独立密钥，落库并在回拨时校验
    const base = typeof controlPlaneBase === "function" ? controlPlaneBase(ctx) : controlPlaneBase;
    const callbackUrl = `${base}/hook/dingtalk/card/${token}?secret=${secret}`;
    const kind = await getCredentialKind(p.robot);

    if (kind === "dingtalk-corp") {
      const corp = await getCredentialSecrets(p.robot);
      await dingtalkCorpProvider.sendApprovalCard({
        robot: corp, target: p.target,
        approver: p.approverUid, text: p.message ?? "请审批该流水线卡点",
        callbackUrl, token,
      });
    } else {
      await dingtalkProvider.sendApprovalCard({
        robot: p.robot, approver: p.approverUid, text: p.message ?? "请审批该流水线卡点",
        callbackUrl, token,
      });
    }
    await ctx.recordRegistry({ kind: "dingtalk", token, secret, execId: ctx.execId, nodeId: node.id });
    return { kind: "wait", ref: token };
  };
}