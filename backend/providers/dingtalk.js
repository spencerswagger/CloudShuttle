// 审批卡点用钉钉自定义机器人（webhook）发送。
// 机器人凭证不放在平台级环境变量，而是作为流程定义里的节点参数
// (approval.params.robot = 凭证库名)，由 getCredentialSecrets 解出。
import { createHmac } from "node:crypto";

// 钉钉机器人加签：timestamp\nsecret 作为 HmacSHA256 密钥，对空字符串签名
function signUrl(url, secret, ts) {
  const key = `${ts}\n${secret}`;
  const sign = createHmac("sha256", key)
    .update("")
    .digest()
    .toString("base64")
    .replace(/\+/g, "%2B").replace(/\//g, "%2F").replace(/=/g, "%3D");
  return `${url}&timestamp=${ts}&sign=${sign}`;
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
      await httpClient.post(url, {
        msgtype: "markdown",
        markdown: { title: `流水线审批卡点 #${token}`, text: md },
      });
    },

    // 决策归一：回调 query 只可能是 approve / reject
    normalizeDecision(d) {
      return d === "reject" ? "reject" : "approve";
    },
  };
}