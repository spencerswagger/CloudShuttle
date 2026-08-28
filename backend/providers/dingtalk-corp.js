// 审批卡点用钉钉企业应用（OpenAPI）发送「卡片实例」互动卡片。
// 走新版卡片实例 API createAndDeliver，群与人都投同一套卡片平台模板：
//   - 群：IM_GROUP 场域，空间 id = openConversationId
//   - 人：IM_ROBOT 场域，空间 id = 用户userId；多人则逐个投递同一实例(outTrackId)
// 按钮在模板内预配置（「回传请求」action=agree/reject），经 callbackRouteKey 回调到服务端。
// 企业信息（appKey/appSecret/agentId/robotCode/cardTemplateId/cardCallbackRouteKey）来自凭证库，SM4 解密后使用。
import { HttpError } from "../errors.js";

const BASE = "https://api.dingtalk.com";

function corpError(status, code, message, detail) {
  throw new HttpError(status, code, message, detail);
}

export function createDingtalkCorpProvider({
  httpClient,   // axios
  getToken,     // (corp) => Promise<accessToken>，含缓存
  clock = Date,
}) {
  // 目标：仅发人（IM_ROBOT）。兼容数组与逗号分隔字符串两种存储形态（通讯录选择器存逗号串）
  function resolveTarget(target, approver) {
    const raw = (target?.type === "user" ? target.openIds : null) ?? (approver ? [approver] : []);
    const openIds = (Array.isArray(raw) ? raw : String(raw ?? "").split(","))
      .map((s) => String(s).trim()).filter(Boolean);
    if (!openIds.length) {
      corpError(400, "BAD_TARGET", "未配置发送的审批人（openId）", "approval target missing openIds/approver");
    }
    return { type: "user", openIds };
  }

  return {
    // 发送审批卡（发人：IM_ROBOT 场域）。robot 为企业机器人凭证（含 appKey/appSecret/robotCode/cardTemplateId/cardCallbackRouteKey）
    // callbackUrl 保留以兼容旧签名，回调统一走 callbackRouteKey，此处忽略。
    async sendApprovalCard({ robot, target, approver, text, callbackUrl, token }) {
      void callbackUrl;
      const accessToken = await getToken(robot);
      const t = resolveTarget(target, approver);
      const mdText =
        `### 流水线审批卡点 · #${token}\n\n` +
        `**审批人**：${approver ?? "-"}\n\n` +
        `${text ?? "请审批该流水线卡点"}`;
      const outTrackId = `cloudshuttle_${token}`;
      for (const uid of t.openIds) {
        await this._createAndDeliver(accessToken, robot, outTrackId, mdText, "IM_ROBOT", uid);
      }
    },

    // 投递一张卡片实例：spaceType ∈ IM_GROUP(群) / IM_ROBOT(机器人单聊)
    async _createAndDeliver(accessToken, robot, outTrackId, markdownText, spaceType, spaceId) {
      const cardTemplateId = robot.cardTemplateId;
      const routeKey = robot.cardCallbackRouteKey;
      if (!cardTemplateId || !routeKey) {
        corpError(400, "BAD_CREDENTIAL",
          "审批需在机器人凭证中配置 cardTemplateId（卡片平台模板ID）与 cardCallbackRouteKey（注册的回调routeKey）",
          "dingtalk-corp missing cardTemplateId/cardCallbackRouteKey");
      }
      const body = {
        cardTemplateId,
        outTrackId,
        callbackType: "HTTP",
        callbackRouteKey: routeKey,
        cardData: { cardParamMap: { markdown: markdownText } },
        openSpaceId: `dtv1.card//${spaceType}.${spaceId}`,
      };
      // 各场域的投递模型：IM_ROBOT 需显式 spaceType
      if (spaceType === "IM_ROBOT") {
        body.imRobotOpenDeliverModel = { spaceType: "IM_ROBOT", robotCode: robot.robotCode };
      } else {
        body.imGroupOpenDeliverModel = { robotCode: robot.robotCode };
      }
      const resp = await httpClient.post(
        `${BASE}/v1.0/card/instances/createAndDeliver`,
        body,
        { headers: { "x-acs-dingtalk-access-token": accessToken, "content-type": "application/json" } }
      );
      // createAndDeliver：success=true 或 result.deliverResults[] 全部 success=true
      const b = resp?.data ?? {};
      if (b?.success === true) return;
      const dRes = b?.result?.deliverResults ?? [];
      if (dRes.length && dRes.every((r) => r?.success === true)) return;
      const detail = JSON.stringify(dRes[0] ?? b).slice(0, 300);
      corpError(502, "DINGTALK_SEND_FAILED", "审批卡片发送失败，请检查卡片模板/回调routeKey配置", detail);
    },

    normalizeDecision(d) {
      return d === "reject" ? "reject" : "approve";
    },
  };
}