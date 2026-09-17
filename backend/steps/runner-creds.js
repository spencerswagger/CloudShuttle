// runner 附加凭证：把 shell 节点声明的凭证引用（params.credentials=[{name}]）按类型组装成
// 可直接写入 k8s Secret 的文件内容与 secretKeyRef 环境变量（A′ 执行契约：凭据由控制面
// 建立 Secret 并落盘，容器内无任何平台初始化逻辑）。
// 凭证密文只出现在新建的 Secret 与容器文件系统里，调度日志/探针/命令通道均不回显。
export const RUNNER_CRED_KINDS = ["ssh", "maven", "docker-registry", "npm", "s3"];

const str = (s, k) => String(s?.[k] ?? "");

// 各类型→Secret 键 → 容器挂载路径（文件型凭证落盘约定）。短值（ssh 口令等）不挂载，走 secretKeyRef。
export const CRED_FILE_LAYOUT = {
  ssh: [
    { key: "ssh_id_rsa", mountPath: "/root/.ssh/id_rsa" },
    { key: "ssh_known_hosts", mountPath: "/root/.ssh/known_hosts" },
  ],
  maven: [{ key: "maven_settings.xml", mountPath: "/root/.m2/settings.xml" }],
  "docker-registry": [{ key: "docker_config.json", mountPath: "/root/.docker/config.json" }],
  npm: [{ key: "npm_npmrc", mountPath: "/root/.npmrc" }],
  s3: [{ key: "s3_s3cfg", mountPath: "/root/.s3cfg" }],
};

// Secret 内短值条目（不进文件，供 secretKeyRef 注入环境变量）
export const CRED_ENV_LAYOUT = {
  ssh: [{ key: "ssh_passphrase", env: "CS_SSH_PASSPHRASE" }],
};

function xmlEscape(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// 单个凭证 → { files: Record<key,text> }（仅含实际有内容的条目；空则跳过，不产生挂载）
function filesOf(kind, secret) {
  const s = secret ?? {};
  switch (kind) {
    case "ssh": {
      const out = {};
      const pk = str(s, "privateKey");
      if (pk) out.ssh_id_rsa = `${pk}\n`;
      const kh = str(s, "knownHosts");
      if (kh) out.ssh_known_hosts = `${kh}\n`;
      const pass = str(s, "passphrase");
      if (pass) out.ssh_passphrase = pass;
      return out;
    }
    case "maven": {
      const serverId = str(s, "serverId");
      if (!serverId) return {};
      const user = xmlEscape(str(s, "username"));
      const pass = xmlEscape(str(s, "password"));
      const url = str(s, "registryUrl").trim();
      let xml = "<settings>\n  <servers>\n    <server>\n      <id>" + xmlEscape(serverId) +
        "</id>\n      <username>" + user + "</username>\n      <password>" + pass + "</password>\n    </server>\n  </servers>\n";
      if (url) {
        xml += "  <mirrors>\n    <mirror>\n      <id>" + xmlEscape(serverId) + "</id>\n" +
          "      <mirrorOf>*</mirrorOf>\n      <url>" + xmlEscape(url) + "</url>\n    </mirror>\n  </mirrors>\n";
      }
      xml += "</settings>";
      return { "maven_settings.xml": xml };
    }
    case "docker-registry": {
      const reg = str(s, "registry").trim();
      if (!reg) return {};
      const user = str(s, "username");
      const pass = str(s, "password");
      const auth = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
      return { "docker_config.json": JSON.stringify({ auths: { [reg]: { auth } } }) };
    }
    case "npm": {
      const reg = str(s, "registry").trim();
      const token = str(s, "token");
      if (!reg || !token) return {};
      const host = reg.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/")[0];
      return host ? { npm_npmrc: `//${host}/:_authToken=${token}\n` } : {};
    }
    case "s3": {
      const ak = str(s, "ak");
      if (!ak) return {};
      const endpoint = str(s, "endpoint").trim();
      const bucket = str(s, "bucket").trim();
      const hostBucket = bucket ? `%(bucket)s.${endpoint}` : endpoint;
      return {
        s3_s3cfg: "access_key = " + ak + "\n" +
          "secret_key = " + str(s, "sk") + "\n" +
          "host_base = " + endpoint + "\n" +
          "host_bucket = " + hostBucket + "\n",
      };
    }
    default:
      return {};
  }
}

/**
 * 组装凭据 Secret 的数据与挂载/环境布局。
 * @param {{refs?: Array<{name?:string}>, getCredential: (name:string)=>Promise<{kind?:string, secret?:object}>}} deps
 * @returns {Promise<{data: Record<string,string>, mounts: Array<{key:string, subPath:string, mountPath:string}>, envRefs: Array<{key:string, env:string}>}>}
 *   data: Secret data（文本，provider 创建时 base64）；mounts: subPath 落盘布局；
 *   envRefs: 由 secretKeyRef 注入环境变量的条目（{key: Secret 键, env: 环境变量名}）。
 */
export async function assembleRunnerCredentials({ refs, getCredential }) {
  const data = {};
  const envRefs = [];
  for (const r of Array.isArray(refs) ? refs : []) {
    const name = String(r?.name ?? "").trim();
    if (!name) continue;
    const cred = await getCredential(name);
    if (!cred || !cred.kind) throw new Error(`附加凭证 "${name}" 不存在`);
    if (!RUNNER_CRED_KINDS.includes(cred.kind)) {
      throw new Error(`附加凭证 "${name}" 类型 ${cred.kind} 不支持注入容器（可用：${RUNNER_CRED_KINDS.join(" / ")}）`);
    }
    Object.assign(data, filesOf(cred.kind, cred.secret));
    for (const e of CRED_ENV_LAYOUT[cred.kind] ?? []) {
      const v = str(cred.secret, e.key.replace(/^ssh_/, ""));
      if (v) envRefs.push({ key: e.key, env: e.env });
    }
  }
  const mounts = [];
  // 仅对实际有数据的类型生成挂载（避免空文件占位；subPath 取 key 名）
  for (const [kind, layout] of Object.entries(CRED_FILE_LAYOUT)) {
    for (const m of layout) {
      if (data[m.key] != null) mounts.push({ key: m.key, subPath: m.key, mountPath: m.mountPath });
    }
  }
  return { data, mounts, envRefs };
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