// 审批卡点用钉钉企业应用（OpenAPI）发送互动卡片。
// 支持两类目标：
//   - 群聊：/v1.0/im/v1.0/robot/interactiveCards/send（普通版 StandardCard，竖排按钮 RETURN_BACK 服务端回传）
//   - 单人：/v1.0/robot/oToMessages/batchSend（机器人单聊消息，按钮为 URL，需用户已建会话）
// 企业信息（appKey/appSecret/agentId/robotCode）来自凭证库，SM4 解密后使用。
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
  // 目标缺省兜底：给了 openId 则发人；否则要求群，缺参会报错
  function resolveTarget(target, approver) {
    if (target?.type === "group") {
      if (!target.openConversationId) {
        corpError(400, "BAD_TARGET", "未配置发送的目标群（openConversationId）", "approval target missing openConversationId");
      }
      return { type: "group", openConversationId: target.openConversationId };
    }
    // 兼容数组与逗号分隔字符串两种存储形态（通讯录选择器存逗号串）
    const raw = (target?.type === "user" ? target.openIds : null) ?? (approver ? [approver] : []);
    const openIds = (Array.isArray(raw) ? raw : String(raw ?? "").split(","))
      .map((s) => String(s).trim()).filter(Boolean);
    if (!openIds.length) {
      corpError(400, "BAD_TARGET", "未配置发送的审批人（openId）", "approval target missing openIds/approver");
    }
    return { type: "user", openIds };
  }

  // 回调 URL：群路径不带 decision（由 RETURN_BACK 的 return_data 提供），单人路径带 decision
  function decisionUrl(callbackUrl, d) {
    const sep = callbackUrl.includes("?") ? "&" : "?";
    return `${callbackUrl}${sep}decision=${d}`;
  }

  return {
    // 发送审批卡。robot 为企业机器人凭证（含 appKey/appSecret/robotCode 等）
    async sendApprovalCard({ robot, target, approver, text, callbackUrl, token }) {
      const accessToken = await getToken(robot);
      const t = resolveTarget(target, approver);
      const mdText =
        `### 流水线审批卡点 · #${token}\n\n` +
        `**审批人**：${approver ?? "-"}\n\n` +
        `${text ?? "请审批该流水线卡点"}`;

      if (t.type === "user") {
        await this._sendToUsers(accessToken, robot, t.openIds, mdText, callbackUrl, token);
      } else {
        await this._sendToGroup(accessToken, robot, t.openConversationId, mdText, callbackUrl, token);
      }
    },

    // 群：新版卡片实例 API createAndDeliver（IM_GROUP 投放）。
    // 卡片内容由「卡片平台」模板 cardTemplateId 决定，正文经 cardData.cardParamMap.markdown 填充，
    // 按钮在模板内预配置（「回传请求」decision=approve/reject），点击经 callbackRouteKey 回调到服务端。
    async _sendToGroup(accessToken, robot, openConversationId, mdText, callbackUrl, token) {
      void callbackUrl; // createAndDeliver 回调走注册的 callbackRouteKey，不再在请求体带 callbackUrl
      const cardTemplateId = robot.cardTemplateId;
      const routeKey = robot.cardCallbackRouteKey;
      if (!cardTemplateId || !routeKey) {
        corpError(400, "BAD_CREDENTIAL",
          "群审批需在机器人凭证中配置 cardTemplateId（卡片平台模板ID）与 cardCallbackRouteKey（注册的回调routeKey）",
          "dingtalk-corp missing cardTemplateId/cardCallbackRouteKey");
      }
      const outTrackId = `cloudshuttle_${token}`;
      const resp = await httpClient.post(
        `${BASE}/v1.0/card/instances/createAndDeliver`,
        {
          cardTemplateId,
          outTrackId,
          callbackType: "HTTP",
          callbackRouteKey: routeKey,
          cardData: { cardParamMap: { markdown: mdText } },
          openSpaceId: `dtv1.card//IM_GROUP.${openConversationId}`,
          imGroupOpenSpaceModel: { supportForward: true },
          imGroupOpenDeliverModel: { robotCode: robot.robotCode },
        },
        { headers: { "x-acs-dingtalk-access-token": accessToken, "content-type": "application/json" } }
      );
      // createAndDeliver：success + result.deliverResults[] 逐场域判定
      const body = resp?.data ?? {};
      if (body?.success === true) return;
      const dRes = body?.result?.deliverResults ?? [];
      const okDeliver = dRes.length && dRes.every((r) => r?.success === true);
      if (okDeliver) return;
      const detail = JSON.stringify(dRes[0] ?? body).slice(0, 300);
      corpError(502, "DINGTALK_SEND_FAILED", "审批卡片发送失败，请检查卡片模板/回调routeKey配置", detail);
    },

    // 人：机器人单聊富文本按钮（按钮为 URL，以来电 webview 快闪回调）
    async _sendToUsers(accessToken, robot, openIds, mdText, callbackUrl, token) {
      const msgParam = JSON.stringify({
        title: `流水线审批卡点 #${token}`,
        text: mdText,
        btnTitle1: "✅ 通过", btnURL1: decisionUrl(callbackUrl, "approve"),
        btnTitle2: "❌ 拒绝", btnURL2: decisionUrl(callbackUrl, "reject"),
      });
      const resp = await httpClient.post(
        `${BASE}/v1.0/robot/oToMessages/batchSend`,
        { robotCode: robot.robotCode, userIds: openIds, msgKey: "sampleActionCard", msgParam },
        { headers: { "x-acs-dingtalk-access-token": accessToken, "content-type": "application/json" } }
      );
      this._assertOk(resp, "oToMessages/batchSend", "审批消息发送失败");
    },

    _assertOk(resp, api, msg) {
      const body = resp?.data ?? {};
      // 成功判定：返回体含业务标识即成功（interactiveCards → processQueryKey；oToMessages → processQueryKeys）
      const hasProcess =
        typeof body?.processQueryKey === "string" && body.processQueryKey.length > 0
        || Array.isArray(body?.processQueryKeys)
        || typeof body?.processCode === "string" && body.processCode.length > 0;
      if (hasProcess) return;
      if (resp?.status >= 400) {
        throw new HttpError(502, "DINGTALK_SEND_FAILED", `${msg}，请检查机器人配置或权限`, JSON.stringify(body).slice(0, 300));
      }
      // 无明确业务标识但 HTTP 200：视为已受理，仅记录日志提示
      throw new HttpError(502, "DINGTALK_SEND_FAILED", `${msg}，请检查机器人配置或权限`, `unexpected response: ${JSON.stringify(body).slice(0, 300)}`);
    },

    normalizeDecision(d) {
      return d === "reject" ? "reject" : "approve";
    },
  };
}