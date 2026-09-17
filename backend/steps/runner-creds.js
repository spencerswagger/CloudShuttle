// runner 附加凭证：把 shell/job 节点声明的凭证引用（params.credentials=[{name}]）按类型
// 组装成 runner 可落盘的 { 短key: secretPayload }，随命令经 /_/hook/job/:token 内部通道下发。
// 凭证 secret 只在拉取命令的鉴权请求里出现，调度日志与探针不回显。
export const RUNNER_CRED_KINDS = ["ssh", "maven", "docker-registry", "npm", "s3"];

// 各类型 → runner 侧短 key
const OUTPUT_KEY = { ssh: "ssh", maven: "maven", "docker-registry": "docker", npm: "npm", s3: "s3" };

// 各类型 → 落盘所需字段（值全部字符串；null/undefined 转空串）
function payloadOf(kind, secret) {
  const s = secret ?? {};
  const str = (k) => String(s[k] ?? "");
  switch (kind) {
    case "ssh":
      return { privateKey: str("privateKey"), passphrase: str("passphrase"), knownHosts: str("knownHosts") };
    case "maven":
      return { serverId: str("serverId"), username: str("username"), password: str("password"), registryUrl: str("registryUrl") };
    case "npm":
      return { registry: str("registry"), token: str("token") };
    case "docker-registry":
      return { registry: str("registry"), username: str("username"), password: str("password") };
    case "s3":
      return { endpoint: str("endpoint"), bucket: str("bucket"), ak: str("ak"), sk: str("sk") };
    default:
      return {};
  }
}

/**
 * 组装 runner credentials payload。
 * @param {{refs: Array<{name?:string}>, getCredential: (name:string)=>Promise<{kind?:string, secret?:object}>}} deps
 * @returns {Promise<Record<string, object>>} 如 { ssh:{...}, docker:{...} }；空引用返回 {}
 */
export async function assembleRunnerCredentials({ refs, getCredential }) {
  const out = {};
  for (const r of Array.isArray(refs) ? refs : []) {
    const name = String(r?.name ?? "").trim();
    if (!name) continue;
    const cred = await getCredential(name);
    if (!cred || !cred.kind) throw new Error(`附加凭证 "${name}" 不存在`);
    if (!RUNNER_CRED_KINDS.includes(cred.kind)) {
      throw new Error(`附加凭证 "${name}" 类型 ${cred.kind} 不支持注入容器（可用：${RUNNER_CRED_KINDS.join(" / ")}）`);
    }
    out[OUTPUT_KEY[cred.kind]] = payloadOf(cred.kind, cred.secret);
  }
  return out;
}

/**
 * 保存前静态校验：节点声明的附加凭证必须存在且类型在允许集。
 * scheme：nodes[].params.credentials = [{name}]
 * @param {object} spec
 * @param {(name:string)=>Promise<{kind?:string}|null>} lookupCred credential 表查询（name → kind/不存在 null）
 * @returns {Promise<string|null>} 错误描述或 null（通过）
 */
export async function validateCredRefs(spec, lookupCred) {
  for (const node of spec?.nodes ?? []) {
    for (const r of node?.params?.credentials ?? []) {
      const name = String(r?.name ?? "").trim();
      if (!name) continue;
      const meta = await lookupCred(name);
      if (!meta) return `节点 ${node.id} 引用了不存在的附加凭证 "${name}"`;
      if (!RUNNER_CRED_KINDS.includes(meta.kind)) {
        return `节点 ${node.id} 的附加凭证 "${name}" 类型 ${meta.kind || "未知"} 不支持注入容器`;
      }
    }
  }
  return null;
}