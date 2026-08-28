// 审批卡点用钉钉自定义机器人（webhook）发送。
// 机器人凭证不放在平台级环境变量，而是作为流程定义里的节点参数
// (approval.params.robot = 凭证库名)，由 getCredentialSecrets 解出。
import { createHmac } from "node:crypto";
import { HttpError } from "../errors.js";

// 钉钉机器人加签：以 secret 为 HMAC 密钥，对「ts\nsecret」签名，结果 base64 后做 URL 编码
function signUrl(url, secret, ts) {
  const sign = createHmac("sha256", secret)
    .update(`${ts}\n${secret}`)
    .digest()
    .toString("base64");
  return `${url}&timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
}

export function createDingtalkProvider({ httpClient, getCredentialSecrets, clock = Date }) {
  async function resolveRobot(robot) {
    const s = await getCredentialSecrets(robot); // { webhook, signSecret? }
    if (!s?.webhook) throw new Error(`robot credential "${robot}" missing webhook`);
    return s;
  }

  return {
    async sendApprovalCard({ robot, approver, text, callbackUrl, token }) {
      const { webhook, signSecret } = await resolveRobot(robot);
      const decisionUrl = (d) => `${callbackUrl}&decision=${d}`;
      const md =
        `### 流水线审批卡点 · #${token}\n\n` +
        `**审批人**：${approver ?? "-"}\n\n` +
        `${text ?? "请审批该流水线卡点"}\n\n` +
        `---\n\n` +
        `[✅ 通过](${decisionUrl("approve")})　[❌ 拒绝](${decisionUrl("reject")})`;
      let url = webhook;
      if (signSecret) url = signUrl(webhook, signSecret, clock.now());
      const resp = await httpClient.post(url, {
        msgtype: "markdown",
        markdown: { title: `流水线审批卡点 #${token}`, text: md },
      });
      const code = resp?.data?.errcode ?? 0;
      if (code) {
        throw new HttpError(
          502,
          "DINGTALK_SEND_FAILED",
          "审批消息发送失败，请检查机器人配置或调用额度",
          `dingtalk errcode=${code} errmsg=${resp?.data?.errmsg ?? ""}`,
        );
      }
    },

    // 决策归一：回调 query 只可能是 approve / reject
    normalizeDecision(d) {
      return d === "reject" ? "reject" : "approve";
    },
  };
}