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
      void approver;
      const accessToken = await getToken(robot);
      const t = resolveTarget(target, approver);
      // 卡片正文由 approval 步骤组装（默认模板 + 用户自定义 + 占位符填充），不再硬拼 uuid
      const mdText = text ?? "请审批该流水线卡点";
      const outTrackId = `cloudshuttle_${token}`;
      console.log(
        `[sendApprovalCard] token=${token} openIds=[${t.openIds.join(",")}] ` +
        `robotCode=${robot?.robotCode} cardTemplateId=${robot?.cardTemplateId} routeKey=${robot?.cardCallbackRouteKey}`
      );
      const results = [];
      for (const uid of t.openIds) {
        try {
          const r = await this._createAndDeliver(accessToken, robot, outTrackId, mdText, "IM_ROBOT", uid);
          results.push({ uid, ...r });
        } catch (err) {
          console.error(`[sendApprovalCard] FAILED uid=${uid} err=${err?.message ?? err}`);
          throw err;
        }
      }
      console.log(`[sendApprovalCard] done token=${token} results=${JSON.stringify(results)}`);
    },

    // 投递一张卡片实例：spaceType ∈ IM_GROUP(群) / IM_ROBOT(机器人单聊)
    async _createAndDeliver(accessToken, robot, outTrackId, markdownText, spaceType, spaceId) {
      const cardTemplateId = robot.cardTemplateId;
      const routeKey = robot.cardCallbackRouteKey;
      // 企业内部应用机器人 RobotCode 即应用 AppKey；未单独配置时兜底为 AppKey
      const robotCode = robot.robotCode || robot.appKey;
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
      // 各场域的投递模型与场域信息：IM_ROBOT 必须同时提供
      // imRobotOpenSpaceModel（场域信息，至少 supportForward）与 imRobotOpenDeliverModel，
      // 只给 deliverModel 会导致钉钉「spaces of card is empty」解析不到接收人空间。
      if (spaceType === "IM_ROBOT") {
        body.imRobotOpenDeliverModel = { spaceType: "IM_ROBOT", robotCode };
        body.imRobotOpenSpaceModel = { supportForward: false };
      } else {
        body.imGroupOpenDeliverModel = { robotCode };
        body.imGroupOpenSpaceModel = { supportForward: true };
      }
      let resp;
      try {
        resp = await httpClient.post(
          `${BASE}/v1.0/card/instances/createAndDeliver`,
          body,
          { headers: { "x-acs-dingtalk-access-token": accessToken, "content-type": "application/json" } }
        );
      } catch (e) {
        const rb = e?.response?.data;
        const detail = rb ? JSON.stringify(rb).slice(0, 500) : String(e?.message ?? e);
        console.error(`[createAndDeliver] HTTP_ERROR spaceType=${spaceType} spaceId=${spaceId} detail=${detail}`);
        corpError(502, "DINGTALK_SEND_FAILED", "审批卡片发送失败（钉钉接口报错），请检查模板/回调routeKey配置", detail);
      }
      // createAndDeliver：顶层 success 仅代表请求受理，真正的逐人投递结果在
      // result.deliverResults[] 中，必须逐条判定，否则会吞掉「接口成功但卡没送达」的失败。
      const raw = resp?.data ?? {};
      const dRes = Array.isArray(raw?.result?.deliverResults) ? raw.result.deliverResults : [];
      const myRes = {};
      if (dRes.length) {
        // 只关心本场域（本空间 id）的投递项，其余场域项忽略
        const mine = dRes.filter((r) => r?.success === false || String(r?.spaceId ?? r?.openSpaceId).includes(spaceId));
        const fail = dRes.find((r) => r?.success === false);
        myRes.deliverResults = dRes.map((r) => ({
          success: r?.success, errorCode: r?.errorCode, errorMessage: r?.errorMessage ?? r?.errorMsg,
        }));
        if (mine.length && (fail || !mine.every((r) => r?.success === true))) {
          const f = fail ?? mine[0];
          console.error(`[createAndDeliver] FAILED spaceType=${spaceType} spaceId=${spaceId} raw=${JSON.stringify(raw).slice(0, 500)}`);
          corpError(502, "DINGTALK_SEND_FAILED", "审批卡片投递失败，请检查模板/回调routeKey与接收人是否已和机器人建会话", JSON.stringify(f ?? raw).slice(0, 300));
        }
      }
      // 无 deliverResults 时以顶层 success 为准，但打印原始响应便于诊断
      if (raw?.success !== true) {
        console.error(`[createAndDeliver] FAILED(no-success) spaceType=${spaceType} spaceId=${spaceId} raw=${JSON.stringify(raw).slice(0, 500)}`);
        const detail = JSON.stringify(dRes[0] ?? raw).slice(0, 300);
        corpError(502, "DINGTALK_SEND_FAILED", "审批卡片发送失败，请检查卡片模板/回调routeKey配置", detail);
      }
      return myRes;
    },

    normalizeDecision(d) {
      return d === "reject" ? "reject" : "approve";
    },
  };
}