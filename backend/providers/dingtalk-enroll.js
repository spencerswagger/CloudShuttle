// 保存钉钉企业机器人凭证时的「校验 + 自动注册回调」：
// 用户只需提供 AppKey/AppSecret（与卡片模板 ID），无需自行创建回调 routeKey。
// 保存时后端用 aksk 换 accessToken，再调用「注册卡片回调地址」接口
// (POST /v1.0/card/callbacks/register) 自动生成 routeKey 并绑定到本控制台回调用。
// 该调用同时校验应用权限『互动卡片实例写权限 Card.Instance.Write』已开通，
// 权限不足或 aksk 无效都会让保存直接失败并给出可读提示。
import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";

export function createDingtalkEnroll({ httpClient, getToken }) {
  return {
    // base: 控制台对外可回拨的基地址（如 https://api-xxx.fcy.zj.cn），缺省无法注册
    async verifyAndRegister({ appKey, appSecret, existingRouteKey, base }) {
      if (!appKey || !appSecret) {
        throw new HttpError(400, "BAD_CREDENTIAL", "钉钉企业机器人需填写 AppKey 与 AppSecret", "dingtalk-enroll missing appKey/appSecret");
      }
      if (!base) {
        throw new HttpError(500, "SERVICE_MISCONFIG", "回调基地址未配置(CONTROL_BASE)，无法自动注册审批回调地址", "dingtalk-enroll missing control base");
      }
      // 1) 校验 aksk 有效：失败时 getToken 抛 DINGTALK_TOKEN_FAILED（并含原因）
      const token = await getToken({ appKey, appSecret });
      const callbackUrl = `${base.replace(/\/$/, "")}/hook/dingtalk/card`;
      const routeKey = existingRouteKey || `cs_cb_${randomUUID()}`;
      console.log(`[dingtalk-enroll] 正在校验并注册审批回调：routeKey=${routeKey} callbackUrl=${callbackUrl}`);
      // 2) 校验『互动卡片实例写权限』并注册 routeKey→callbackUrl；更新复用原 routeKey + forceUpdate 覆盖
      try {
        await httpClient.post(
          "https://api.dingtalk.com/v1.0/card/callbacks/register",
          {
            callbackRouteKey: routeKey,
            callbackType: "HTTP",
            callbackUrl,
            forceUpdate: existingRouteKey ? true : undefined,
          },
          { headers: { "x-acs-dingtalk-access-token": token, "content-type": "application/json" } }
        );
      } catch (e) {
        const body = e?.response?.data;
        const detail = body ? JSON.stringify(body).slice(0, 500) : String(e?.message ?? e);
        console.error(`[dingtalk-enroll] 注册审批回调失败 routeKey=${routeKey} ${detail}`);
        throw new HttpError(
          502,
          "DINGTALK_REGISTER_FAILED",
          "钉钉校验未通过：无法注册审批卡片回调地址，请确认已为应用开通『互动卡片实例写权限』(Card.Instance.Write)",
          `register routeKey=${routeKey} ${detail}`
        );
      }
      console.log(`[dingtalk-enroll] ✔ 审批回调注册成功 routeKey=${routeKey}`);
      return { routeKey };
    },

    // 尽力拉取展示辅助信息（企业名称 / 应用名称 / 应用图标）用于凭证下拉辅助区分。
    // 不强制要求：任一个接口权限未开或失败，只留空对应字段，不阻断保存。
    async fetchProfile({ appKey, appSecret }) {
      const profile = { corpName: "", appName: "", appIcon: "" };
      if (!appKey || !appSecret) return profile;
      const token = await getToken({ appKey, appSecret });
      // 1) 企业名称：GET /v1.0/contact/organizations/authInfos（不传 targetCorpId 查当前企业）
      try {
        const r = await httpClient.get("https://api.dingtalk.com/v1.0/contact/organizations/authInfos", {
          headers: { "x-acs-dingtalk-access-token": token, "content-type": "application/json" },
        });
        const b = r?.data ?? {};
        profile.corpName = b?.orgName || b?.licenseOrgName || "";
      } catch (e) {
        console.warn("[dingtalk-enroll] 拉取企业名称失败(可忽略)，需『通讯录组织基础信息读权限』:",
          e?.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : e?.message ?? e);
      }
      // 2) 应用名称/图标：GET /v1.0/microApp/allInnerApps，按机器人编码(=AppKey)匹配
      try {
        const r = await httpClient.get("https://api.dingtalk.com/v1.0/microApp/allInnerApps", {
          headers: { "x-acs-dingtalk-access-token": token, "content-type": "application/json" },
        });
        const list = Array.isArray(r?.data?.appList) ? r.data.appList : [];
        const hit = list.find((a) => a?.robotInfo?.robotCode === appKey) || list.find((a) => a?.robotInfo) || list[0];
        profile.appName = hit?.name || "";
        profile.appIcon = hit?.icon || "";
      } catch (e) {
        console.warn("[dingtalk-enroll] 拉取应用信息失败(可忽略)，需『企业已安装的应用列表查询权限』:",
          e?.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : e?.message ?? e);
      }
      return profile;
    },
  };
}