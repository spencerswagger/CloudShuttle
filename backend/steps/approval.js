// approval 节点：只走钉钉企业机器人（dingtalk-corp）的最新版互动卡片（卡片实例 createAndDeliver）。
// 发送 → dingtalkCorpProvider.sendApprovalCard（发人 IM_ROBOT / 发群 IM_GROUP）。
// 生成 token + 独立 secret 落库，回调统一走 /hook/dingtalk/card/:token。
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
    const corp = await getCredentialSecrets(p.robot);
    console.log(
      `[approval] pipeline=${ctx.execId} node=${node.id} robot=${p.robot} ` +
      `corp.robotCode=${corp?.robotCode} corp.cardTemplateId=${corp?.cardTemplateId} corp.routeKey=${corp?.cardCallbackRouteKey}`
    );
    await dingtalkCorpProvider.sendApprovalCard({
      robot: corp, target: p.target,
      approver: p.approverUid, text: p.message ?? "请审批该流水线卡点",
      callbackUrl, token,
    });
    await ctx.recordRegistry({ kind: "dingtalk", token, secret, credential: p.robot, execId: ctx.execId, nodeId: node.id });
    return { kind: "wait", ref: token };
  };
}