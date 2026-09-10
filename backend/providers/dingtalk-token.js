// 企业 accessToken 换取与缓存：POST /v1.0/oauth2/accessToken，按 appKey 缓存并在到期前续期
import { HttpError } from "../errors.js";

export function createDingtalkTokenCache({ httpClient }) {
  const cache = new Map(); // appKey -> { token, expireAt }

  function isFresh(entry, cushionMs) {
    return entry && entry.expireAt > Date.now() + cushionMs;
  }

  return async function getToken(corp) {
    const key = corp?.appKey;
    if (!key || !corp?.appSecret) {
      throw new HttpError(400, "BAD_CREDENTIAL", "钉钉企业应用凭据不完整", "dingtalk-corp missing appKey/appSecret");
    }
    const cached = cache.get(key);
    if (isFresh(cached, 30_000)) return cached.token; // 到期前 30s 续期

    let resp;
    try {
      resp = await httpClient.post(
        "https://api.dingtalk.com/v1.0/oauth2/accessToken",
        { appKey: key, appSecret: corp.appSecret },
        { headers: { "content-type": "application/json" } }
      );
    } catch (e) {
      const detail = e?.response?.data ? JSON.stringify(e.response.data).slice(0, 400) : String(e?.message ?? e);
      throw new HttpError(
        401,
        "DINGTALK_TOKEN_FAILED",
        "获取钉钉访问令牌失败，请检查 AppKey/AppSecret 与权限",
        `gettoken ${detail}`
      );
    }
    const body = resp?.data ?? {};
    const accessToken = body?.accessToken;
    if (!accessToken) {
      throw new HttpError(
        502,
        "DINGTALK_TOKEN_FAILED",
        "获取钉钉访问令牌失败，请检查企业应用凭据与权限",
        `gettoken body=${JSON.stringify(body).slice(0, 300)}`
      );
    }
    const ttl = Number(body?.expireIn ?? 7200) * 1000;
    cache.set(key, { token: accessToken, expireAt: Date.now() + ttl });
    return accessToken;
  };
}