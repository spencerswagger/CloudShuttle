// backend/handlers/api.js —— /api/* 管道/凭证/镜像/执行 CRUD
// 全程使用 db/pg.js 的 pool 直接执行 SQL（列名对齐 db/migrations/*.sql）；
// 凭证写入时用 crypto/sm4.js 的 SM4 加密后再入库。
import { pool } from "../db/pg.js";
import { config } from "../config.js";
import { sm4Encrypt, sm4Decrypt } from "../crypto/sm4.js";
import { HttpError } from "../errors.js";
import { buildDbConfig, createConnection } from "../providers/db.js";
import { parseKubeconfig, createK8sProvider, k8sErrorHint } from "../providers/k8s.js";
import { randomUUID } from "node:crypto";
import crypto from "node:crypto";
import axios from "axios";
import { checkVars, resolveScope } from "../engine/variables.js";
import { validateCredRefs } from "../steps/runner-creds.js";
import { buildGraph, ancestors, validateSpec } from "../engine/dag.js";

const rows = (r) => r.rows;

// 解析请求体里的流水线配置对象；spec_json 既可能是已解析对象也可能是 JSON 字符串
function resolveSpec(body) {
  if (typeof body?.spec_json === "string") {
    try { return JSON.parse(body.spec_json); }
    catch { throw new HttpError(400, "BAD_SPEC_JSON", "流水线配置格式错误"); }
  }
  return body?.spec_json ?? {};
}

// 保存前静态校验变量引用是否落在节点静态作用域内；未解析变量时返回中文错误串并抛出 422
function assertVarsResolved(spec) {
  const err = checkVars(spec, { ancestors });
  if (err) throw new HttpError(422, "VAR_UNRESOLVED", err, "unknown variable");
}

// 保存前静态校验 runner 附加凭证：引用的凭证必须存在且类型在允许集（ssh/maven/docker-registry/npm/s3）
async function assertCredsResolved(spec) {
  const lookupCred = async (name) => {
    const { rows } = await pool.query(
      `SELECT kind FROM credential WHERE name=$1 AND deleted_at IS NULL`, [name]
    );
    return rows[0] ?? null;
  };
  const err = await validateCredRefs(spec, lookupCred);
  if (err) throw new HttpError(422, "CRED_UNRESOLVED", err, "unknown credential");
}

// 保存前 DAG 校验（节点唯一/边端点/无环/边条件格式/loop 区域）；非法直接 400
function assertDagValid(spec) {
  const checked = validateSpec(spec);
  if (!checked.ok) throw new HttpError(400, "BAD_DAG", "DAG 校验失败：" + checked.errors.join("；"));
}

// 把当前 spec 对应版本登记进 pipeline_rev（历史版本表）
async function snapshotRev(pipelineId, rev, spec) {
  await pool.query(
    `INSERT INTO pipeline_rev(pipeline_id, rev, spec_json) VALUES($1,$2,$3::jsonb)`,
    [pipelineId, rev, spec]
  );
}

// ---------- 管道 ----------
// 管道对外返显列（共享常量，list/get/create/update 四处同源，避免漂移）：
// webhook_secret 属敏感字段，只能经 GET /api/pipelines/:id/webhook-secret 显式获取，
// 因此 create/update 的 RETURNING 也走这份列清单，不再用 RETURNING * 把密钥带回响应。
export const PIPELINE_COLUMNS = "id, name, description, spec_json, rev, created_at, updated_at";

export async function listPipelines() {
  return rows(
    await pool.query(`SELECT ${PIPELINE_COLUMNS} FROM pipeline WHERE deleted_at IS NULL ORDER BY id`)
  );
}

// 详情（编辑返显用）：单条流水线，含完整 spec_json
export async function getPipeline(id) {
  const { rows } = await pool.query(
    `SELECT ${PIPELINE_COLUMNS} FROM pipeline WHERE id=$1 AND deleted_at IS NULL`,
    [id]
  );
  if (!rows[0]) throw new HttpError(404, "PIPELINE_NOT_FOUND", "流水线不存在");
  return rows[0];
}

export async function createPipeline(body) {
  const specObj = resolveSpec(body);
  // 结构校验先行、语义校验在后：悬挂边（端点不在 nodes）会让 checkVars 的 buildGraph
  // 对 undefined 直接 push → 裸 TypeError → 500；必须先由 validateSpec 拦成 400 BAD_DAG，
  // 与运行时（hydrateForRun）的校验契约保持一致。
  assertDagValid(specObj);
  assertVarsResolved(specObj);
  await assertCredsResolved(specObj);
  const spec = JSON.stringify(specObj);
  // 每条管道的 webhook 触发独立密钥，创建时生成并存库
  const webhookSecret = randomUUID();
  const { rows: r } = await pool.query(
    `INSERT INTO pipeline(name, description, spec_json, webhook_secret) VALUES($1,$2,$3::jsonb,$4)
     RETURNING ${PIPELINE_COLUMNS}`,
    [body?.name, body?.description ?? null, spec, webhookSecret]
  );
  await snapshotRev(r[0].id, 1, spec);
  return r[0];
}

// webhook 触发地址（纯函数，可单测）：{base}/hook/webhook/{name}?secret={secret}
// base 为空时退化为站点相对路径（前端可按需补 origin）；base 末尾多余斜杠会被去掉。
export function buildWebhookUrl({ base = "", name, secret }) {
  const trimmed = String(base ?? "").trim().replace(/\/+$/, "");
  const path = `/hook/webhook/${encodeURIComponent(String(name ?? ""))}`;
  return `${trimmed}${path}?secret=${encodeURIComponent(String(secret ?? ""))}`;
}

// 查看/生成该管道的 webhook 触发密钥与完整回调地址（懒生成：为空则补一个）
// name 与 secret 同一条 SELECT 读出；url 由后端生成，前端只展示/复制。
export async function getWebhookSecret(id, { base = "" } = {}) {
  const { rows: r } = await pool.query(
    `SELECT name, webhook_secret FROM pipeline WHERE id=$1 AND deleted_at IS NULL`,
    [id]
  );
  if (!r[0]) return null;
  let secret = r[0].webhook_secret;
  if (!secret) {
    secret = randomUUID();
    await pool.query(`UPDATE pipeline SET webhook_secret=$2 WHERE id=$1`, [id, secret]);
  }
  return { ok: true, id, name: r[0].name, secret, url: buildWebhookUrl({ base, name: r[0].name, secret }) };
}

// 重置 webhook 触发密钥（泄露或轮换用），一并返回新的回调地址
export async function resetWebhookSecret(id, { base = "" } = {}) {
  const secret = randomUUID();
  const { rows: r } = await pool.query(
    `UPDATE pipeline SET webhook_secret=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING name`,
    [id, secret]
  );
  if (!r[0]) return null;
  return { ok: true, id, name: r[0].name, secret, url: buildWebhookUrl({ base, name: r[0].name, secret }) };
}

// 调试探针：该管道最近一次 webhook 投递的原始 body 与本次处理结果（httpStatus：200=触发成功、
// 401=密钥不匹配、503=密钥未配置、500=处理抛错；null=无记录）。响应契约：
// { ok:true, body, receivedAt, httpStatus }
export async function getWebhookProbe(id) {
  const { rows } = await pool.query(
    `SELECT body, received_at, http_status FROM webhook_probe WHERE pipeline_id=$1`,
    [id]
  );
  const row = rows[0];
  return {
    ok: true,
    body: row?.body ?? null,
    receivedAt: row?.received_at ? new Date(row.received_at).toISOString() : null,
    httpStatus: row?.http_status ?? null,
  };
}

// 查询指定钉钉企业机器人可发送的场景群（供后台选取 openConversationId）
export async function listDingtalkGroups({ credential, getCredentialSecrets, getAccessToken, httpClient }) {
  const secrets = await getCredentialSecrets(credential);
  const accessToken = await getAccessToken(secrets);
  const resp = await httpClient.post(
    "https://api.dingtalk.com/v1.0/im/robot/sceneGroups/queryAllGroups",
    {},
    { headers: { "x-acs-dingtalk-access-token": accessToken, "content-type": "application/json" } }
  );
  const result = resp?.data?.result ?? [];
  return {
    groups: result.map((g) => ({
      openConversationId: g.openConversationId,
      title: g.title ?? g.name ?? "",
    })),
  };
}

// 按手机号解析 userId —— 不使用（钉钉 by_mobile 接口已变更/不存在），改走通讯录部门接口
// 保留函数签名以兼容引用，但建议用 listDepartments/listDepartmentUsers 代替。

// 获取下一级部门（oapi /topapi/v2/department/listsub）
export async function listDepartments({ credential, deptId, getCredentialSecrets, getAccessToken, httpClient }) {
  const secrets = await getCredentialSecrets(credential);
  const accessToken = await getAccessToken(secrets);
  const resp = await httpClient.post(
    "https://oapi.dingtalk.com/topapi/v2/department/listsub",
    oapiForm({ access_token: accessToken, dept_id: deptId ?? 1 }),
    { headers: { "content-type": "application/x-www-form-urlencoded" } }
  );
  const r = resp?.data ?? {};
  if (r.errcode != null && r.errcode !== 0) {
    throw new HttpError(502, "DINGTALK_ORG_FAILED", "获取部门列表失败",
      `listsub errcode=${r.errcode} errmsg=${r.errmsg}`);
  }
  return {
    departments: (r.result ?? []).map((d) => ({ id: d.dept_id, name: d.name, parentId: d.parent_id })),
  };
}

// 获取部门内用户基础信息（oapi /topapi/user/listsimple，仅 userId+name，不含子部门）
export async function listDepartmentUsers({ credential, deptId, getCredentialSecrets, getAccessToken, httpClient }) {
  const secrets = await getCredentialSecrets(credential);
  const accessToken = await getAccessToken(secrets);
  const resp = await httpClient.post(
    "https://oapi.dingtalk.com/topapi/user/listsimple",
    oapiForm({ access_token: accessToken, dept_id: deptId ?? 1, cursor: 0, size: 100 }),
    { headers: { "content-type": "application/x-www-form-urlencoded" } }
  );
  const r = resp?.data ?? {};
  if (r.errcode != null && r.errcode !== 0) {
    throw new HttpError(502, "DINGTALK_ORG_FAILED", "获取部门成员失败",
      `listsimple errcode=${r.errcode} errmsg=${r.errmsg}`);
  }
  return {
    users: (r.result?.list ?? []).map((u) => ({ userId: u.userid, name: u.name })),
    hasMore: !!r.result?.has_more,
  };
}

function oapiForm(data) { return new URLSearchParams(data).toString(); }

// 编辑管道：name/description 与 spec 一并落库（前端可编辑这两项，之前 SET 漏掉导致改名不生效）。
// 注意：改名后 webhook 触发地址随 name 变化，需由前端提示用户重新复制地址。
export async function updatePipeline(id, body) {
  const specObj = resolveSpec(body);
  // 同 createPipeline：DAG 结构校验先行（悬挂边 400 BAD_DAG），变量语义校验在后
  assertDagValid(specObj);
  assertVarsResolved(specObj);
  await assertCredsResolved(specObj);
  const spec = JSON.stringify(specObj);
  const { rows: r } = await pool.query(
    `UPDATE pipeline SET name=$2, description=$3, spec_json=$4::jsonb, rev=rev+1, updated_at=now()
      WHERE id=$1 AND deleted_at IS NULL RETURNING ${PIPELINE_COLUMNS}`,
    [id, body?.name, body?.description ?? null, spec]
  );
  if (r[0]) await snapshotRev(id, r[0].rev, spec);
  return r[0];
}

// 某节点当前可用变量（与保存校验同一作用域口径）：全局 key ∪ 前驱节点声明的 outputs key
// nodeId 为空或不存在时返回空数组，前端仅作提示、不必报错。
export async function getNodeScope(id, nodeId) {
  const { rows: r } = await pool.query(
    `SELECT spec_json FROM pipeline_rev WHERE pipeline_id=$1 ORDER BY rev DESC LIMIT 1`,
    [id]
  );
  const spec = r[0]?.spec_json ?? {};
  const graph = buildGraph(spec);
  const node = nodeId == null ? null : String(nodeId);
  if (!node || !graph.nodes.has(node)) return { keys: [] };
  const scope = resolveScope(graph, spec, ancestors, node);
  return { keys: [...scope].sort() };
}

// 软删除流水线：只打 deleted_at 标记，历史执行/执行日志/rev 全量保留（原物理删除会因
// execution_log 外键失败 500，且丢失审计轨迹）。活跃行不再唯一冲突，允许删除后同名重建。
export async function deletePipeline(id) {
  const { rows: r } = await pool.query(
    `UPDATE pipeline SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
    [id]
  );
  return rows({ rows: r })[0];
}

export async function deleteCredential(id) {
  const { rows: r } = await pool.query(
    `UPDATE credential SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id,name`,
    [id]
  );
  return rows({ rows: r })[0];
}

// 测试连接 config 纯函数：在 buildDbConfig 基础上叠加「5s 限时安全网」。
// 仅当用户未显式配置合法的驱动连接超时（顶层键或 extra 自定义项）时兜底为 5000ms，
// 防不可达主机挂住表单请求；用户显式配置则尊重其值，非法值（如 "abc"）不得绕过安全网。
// 注意：该端点允许对任意 host 建连探测（内网数据库即特性目标），SSRF 面依赖网关隔离。
export function buildTestConfig(kind, secret) {
  const timeoutKey = kind === "pg" ? "connectionTimeoutMillis" : "connectTimeout";
  const cfg = buildDbConfig(kind, secret);
  // 判定用户是否显式配置了「合法」的驱动超时：值必须可解析为有限数值，否则视为未配置
  const validNum = (v) => {
    if (typeof v === "string" && v.trim() === "") return false;
    return v != null && Number.isFinite(Number(v));
  };
  const hasUserTimeout =
    validNum(secret?.[timeoutKey]) ||
    (Array.isArray(secret?.extra) && secret.extra.some((x) => x?.key === timeoutKey && validNum(x?.value)));
  // 测试连接 5s 限时安全网：仅当用户未显式配置驱动超时时兜底（防不可达主机挂住表单请求）
  if (!hasUserTimeout) cfg[timeoutKey] = 5000;
  return cfg;
}

// 测试连接（mysql/pg/k8s/maven/npm/docker-registry/s3）：草稿 secret 直连探测，成功能返回耗时；
// 失败抛可读错误（DISPATCH 捕获后降级为 200 + {ok:false,message}）。
// http 可注入便于单测（默认 axios）。
export function makeTestCredentialConnection({ createConnection: open, pingK8s, http = axios }) {
  const probe = async (fn) => {
    const start = Date.now();
    await fn();
    return { ok: true, latencyMs: Date.now() - start };
  };
  const failed = (err, label) => {
    let msg = String(err?.response?.data?.message ?? err?.message ?? err).split("\n")[0].slice(0, 200);
    const status = err?.response?.status;
    if (status === 401 || status === 403) msg = `${label}凭证无效（HTTP ${status}），请检查账号/密码/Token`;
    if (status === 404) msg = `${label}地址不存在（HTTP 404），请检查 URL 是否可访问`;
    return msg;
  };
  return async function testCredentialConnection({ kind, secret }) {
    if (kind === "k8s") {
      // Kubernetes：解析 kubeconfig + 连通性探测（能列出 namespaces 即视为可达）
      try {
        const kube = parseKubeconfig(secret?.kubeconfig);
        const start = Date.now();
        await (pingK8s ?? createK8sProvider().ping)(kube);
        return { ok: true, latencyMs: Date.now() - start };
      } catch (err) {
        throw new Error(`Kubernetes 集群连接失败：${k8sErrorHint(err) || "未知错误"}`);
      }
    }
    if (kind === "maven") {
      const url = String(secret?.registryUrl ?? "").trim();
      if (!url) throw new Error("请先填写「仓库地址（可选，作镜像）」才能测试连接（无仓库地址无法探测）");
      try {
        return await probe(() => http.get(url, {
          timeout: 8000,
          auth: { username: String(secret?.username ?? ""), password: String(secret?.password ?? "") },
        }));
      } catch (err) {
        throw new Error(`Maven 私服连接失败：${failed(err, "Maven 私服")}`);
      }
    }
    if (kind === "npm") {
      const registry = String(secret?.registry ?? "").trim().replace(/\/+$/, "");
      if (!registry) throw new Error("请先填写 Registry 地址再测试连接");
      try {
        return await probe(() => http.get(`${registry}/-/whoami`, {
          timeout: 8000,
          headers: { Authorization: `Bearer ${String(secret?.token ?? "")}` },
        }));
      } catch (err) {
        throw new Error(`npm 源连接失败：${failed(err, "npm")}`);
      }
    }
    if (kind === "docker-registry") {
      const registry = String(secret?.registry ?? "").trim();
      if (!registry) throw new Error("请先填写仓库地址再测试连接");
      try {
        return await probe(() => http.get(`${registry.startsWith("http") ? "" : "https://"}${registry}/v2/`, {
          timeout: 8000,
          auth: { username: String(secret?.username ?? ""), password: String(secret?.password ?? "") },
        }));
      } catch (err) {
        throw new Error(`Docker 仓库连接失败：${failed(err, "Docker 仓库")}`);
      }
    }
    if (kind === "s3") {
      // S3：SigV4 签名后探测（有 bucket 则列 bucket 内容，否则列 bucket 列表）
      try {
        const endpoint = String(secret?.endpoint ?? "").trim();
        if (!endpoint) throw new Error("请先填写 Endpoint 再测试连接");
        const bucket = String(secret?.bucket ?? "").trim();
        const host = endpoint.startsWith("http") ? endpoint.replace(/^https?:\/\//, "") : endpoint;
        const useTls = !endpoint.startsWith("http://");
        const url = useTls ? `https://${host}` : `http://${host}`;
        const req = signedS3Request({
          method: "GET", host,
          path: bucket ? `/${bucket}?max-keys=0` : "/",
          region: "us-east-1",
          ak: String(secret?.ak ?? ""), sk: String(secret?.sk ?? ""),
        });
        const reqPath = bucket ? `/${bucket}?max-keys=0` : "/";
        return await probe(() => http.request({ ...req, url: `${url}${reqPath}`, timeout: 8000 }).then((r) => r));
      } catch (err) {
        throw new Error(`对象存储连接失败：${failed(err, "S3")}`);
      }
    }
    if (kind !== "mysql" && kind !== "pg") {
      throw new HttpError(400, "BAD_DB_KIND", `不支持的数据库类型：${kind || "未填写"}`);
    }
    const cfg = buildTestConfig(kind, secret);
    const start = Date.now();
    const conn = await open(kind, cfg, { raw: true });
    try {
      await conn.query("SELECT 1");
      return { ok: true, latencyMs: Date.now() - start };
    } finally {
      try { await conn.end(); } catch { /* 忽略 */ }
    }
  };
}

// 极简 AWS SigV4 签名（S3 兼容存储测试连接用；区域默认 us-east-1 与 OSS/MinIO 兼容）
function signedS3Request({ method, host, path, region, ak, sk }) {
  const { createHmac, createHash } = crypto;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const service = "s3";
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${EMPTY_HASH}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `${method}\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${EMPTY_HASH}`;
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
  const kDate = hmac(`AWS4${sk}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return {
    method,
    headers: {
      Host: host,
      "X-Amz-Date": amzDate,
      "X-Amz-Content-Sha256": EMPTY_HASH,
      Authorization: `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}
const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// SSH 密钥对生成（WEB 页面一键生成；私钥回填表单、公钥供用户复制配置授权）
export function generateSshKeypair({ type = "ed25519" } = {}) {
  const { generateKeyPairSync, createPublicKey } = crypto;
  const { publicKey, privateKey } = generateKeyPairSync(type, {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  // 转 OpenSSH 公钥格式（ssh-ed25519 AAAA...），便于直接粘贴到 SSH 授权（如 GitHub Deploy keys）
  const der = createPublicKey(publicKey).export({ type: "spki", format: "der" });
  const openssh = type === "ed25519" ? "ssh-ed25519 " : "ssh-rsa ";
  const b64 = Buffer.from(sshWire(der, type)).toString("base64");
  return { publicKey: `${openssh}${b64} ${new Date().toISOString().slice(0, 10)}`, privateKey };
}

// SPKI DER → SSH 公钥 wire 格式（SSH2 编码：string 算法 + string 密钥）
function sshWire(der, type) {
  const algName = type === "ed25519" ? "ssh-ed25519" : "ssh-rsa";
  const algBuf = Buffer.from(algName);
  let rest = der;
  if (type === "ed25519") {
    // SPKI 里最后 32 字节为原始 ed25519 公钥；导出为 string 前缀即可
    const key = der.subarray(der.length - 32);
    return Buffer.concat([sshString(algBuf), sshString(key)]);
  }
  // RSA：从 SPKI DER 解析 (n, e) 两项
  void rest;
  const parsed = parseRsaSpki(der);
  return Buffer.concat([sshString(algBuf), sshString(parsed.e), sshString(parsed.n)]);
}
function sshString(buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}
// 解析 RSA SPKI（PKCS#8 外层 + RSAPublicKey 内层）取 n/e
function parseRsaSpki(der) {
  // 简易 DER 遍历：SEQUENCE{ AlgId, BIT STRING{ SEQ{ INT n, INT e } } }
  let off = 0;
  const read = (b) => b[off++];
  const readLen = (b) => {
    const l0 = read(b);
    if (l0 < 0x80) return l0;
    const n = l0 & 0x7f;
    let len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + read(b);
    return len;
  };
  if (read(der) !== 0x30) throw new Error("bad spki");
  readLen(der);
  // AlgorithmIdentifier
  if (read(der) !== 0x30) throw new Error("bad alg");
  const algLen = readLen(der);
  off += algLen;
  // BIT STRING
  if (read(der) !== 0x03) throw new Error("bad bits");
  const bitLen = readLen(der);
  const bitEnd = off + bitLen;
  const unused = read(der);
  void unused;
  // RSAPublicKey SEQUENCE
  if (read(der) !== 0x30) throw new Error("bad rsa");
  readLen(der);
  const readInt = () => {
    if (read(der) !== 0x02) throw new Error("bad int");
    const len = readLen(der);
    let v = Buffer.from(der.subarray(off, off + len));
    off += len;
    // 去掉多余前导 0
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    return v;
  };
  const n = readInt();
  const e = readInt();
  void bitEnd;
  return { n, e };
}

export const testCredentialConnection = makeTestCredentialConnection({ createConnection });

// ---------- 凭证（不回显 secret_enc 明文） ----------
export async function listCredentials() {
  return rows(
    await pool.query(`SELECT id, name, kind, display_meta, created_at FROM credential WHERE deleted_at IS NULL ORDER BY id`)
  );
}

// 详情（编辑返显用）：不回显 secret_enc 明文
export async function getCredential(id) {
  const { rows } = await pool.query(
    `SELECT id, name, kind, display_meta, created_at FROM credential WHERE id=$1 AND deleted_at IS NULL`, [id]
  );
  if (!rows[0]) throw new HttpError(404, "CREDENTIAL_NOT_FOUND", "凭证不存在");
  return rows[0];
}

// 钉钉企业机器人：保存前校验 aksk、自动注册回调，并尽力拉取展示辅助信息（企业/应用名与图标）
async function enrollDingtalk(secret, existingRouteKey, deps) {
  const { routeKey } = await deps.enroll.verifyAndRegister({
    appKey: secret?.appKey,
    appSecret: secret?.appSecret,
    existingRouteKey,
    base: deps.base,
  });
  const meta = await deps.enroll.fetchProfile({ appKey: secret?.appKey, appSecret: secret?.appSecret })
    .catch(() => ({}));
  return {
    secret: { ...(secret ?? {}), cardCallbackRouteKey: routeKey },
    meta: meta ?? {},
  };
}

export async function createCredential(body, deps) {
  if (!config.sm4Key) {
    throw new HttpError(
      500,
      "SERVICE_MISCONFIG",
      "系统加解密配置缺失，请联系管理员处理",
      "SM4_KEY not configured in control plane env; secret cannot be stored",
    );
  }
  const kind = body?.kind;
  let secret;
  let meta = {};
  // 钉钉：先调通(校验 aksk + 权限 + 注册回调 + 拉取企业/应用信息)再落库，失败则保存失败
  if (kind === "dingtalk-corp") {
    const r = await enrollDingtalk(body?.secret ?? {}, null, deps);
    secret = r.secret;
    meta = r.meta;
  } else {
    secret = { ...(body?.secret ?? {}) };
  }
  const enc = sm4Encrypt(config.sm4Key, secret);
  const { rows: r } = await pool.query(
    `INSERT INTO credential(name, kind, secret_enc, display_meta) VALUES($1,$2,$3,$4::jsonb) RETURNING id,name,kind`,
    [body?.name, kind, enc, meta]
  );
  return r[0];
}

// 编辑凭证：可改 name；当 secret 请求体非空时一并重加密落库（留空则保持原 secret）
export async function updateCredential(id, body, deps) {
  const kind = body?.kind;
  if (kind === "dingtalk-corp") {
    if (!config.sm4Key) {
      throw new HttpError(500, "SERVICE_MISCONFIG", "系统加解密配置缺失，请联系管理员处理",
        "SM4_KEY not configured; cannot update credential secret");
    }
    const { rows: cur } = await pool.query(`SELECT secret_enc FROM credential WHERE id=$1 AND deleted_at IS NULL`, [id]);
    const orig = cur[0] ? sm4Decrypt(config.sm4Key, cur[0].secret_enc) : {};
    // 敏感项留空则沿用原值；校验并复用原 routeKey 重新注册（forceUpdate 覆盖），并刷新展示信息
    const merged = { ...orig, ...(body?.secret && typeof body.secret === "object" ? body.secret : {}) };
    const r = await enrollDingtalk(merged, merged.cardCallbackRouteKey, deps);
    const enc = sm4Encrypt(config.sm4Key, r.secret);
    const { rows: rr } = await pool.query(
      `UPDATE credential SET name=$2, secret_enc=$3, display_meta=$4::jsonb, updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id,name,kind`,
      [id, body?.name, enc, r.meta]
    );
    if (!rr[0]) throw new HttpError(404, "CREDENTIAL_NOT_FOUND", "凭证不存在");
    return rr[0];
  }
  let enc;
  const secret = body?.secret;
  if (secret && typeof secret === "object" && Object.keys(secret).length) {
    if (!config.sm4Key) {
      throw new HttpError(500, "SERVICE_MISCONFIG", "系统加解密配置缺失，请联系管理员处理",
        "SM4_KEY not configured; cannot update credential secret");
    }
    enc = sm4Encrypt(config.sm4Key, secret);
  }
  const sql = enc
    ? `UPDATE credential SET name=$2, secret_enc=$3, updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id,name,kind`
    : `UPDATE credential SET name=$2, updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id,name,kind`;
  const args = enc ? [id, body?.name, enc] : [id, body?.name];
  const { rows: r } = await pool.query(sql, args);
  if (!r[0]) throw new HttpError(404, "CREDENTIAL_NOT_FOUND", "凭证不存在");
  return r[0];
}

// ---------- 镜像 ----------
export async function listImages() {
  return rows(await pool.query("SELECT * FROM exec_image WHERE deleted_at IS NULL ORDER BY category,id"));
}

// 详情（编辑返显用）
export async function getImage(id) {
  const { rows } = await pool.query(`SELECT * FROM exec_image WHERE id=$1 AND deleted_at IS NULL`, [id]);
  if (!rows[0]) throw new HttpError(404, "IMAGE_NOT_FOUND", "镜像不存在");
  return rows[0];
}

export async function createImage(body) {
  const { rows: r } = await pool.query(
    `INSERT INTO exec_image(name, image, category, builtin) VALUES($1,$2,$3,$4) RETURNING *`,
    [body?.name, body?.image, body?.category, body?.builtin ?? false]
  );
  return r[0];
}

export async function updateImage(id, body) {
  const { rows: r } = await pool.query(
    `UPDATE exec_image SET name=$2, image=$3, category=$4 WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
    [id, body?.name, body?.image, body?.category ?? "通用"]
  );
  if (!r[0]) throw new HttpError(404, "IMAGE_NOT_FOUND", "镜像不存在");
  return r[0];
}

export async function deleteImage(id) {
  const { rows: r } = await pool.query(`UPDATE exec_image SET deleted_at=now() WHERE id=$1 RETURNING id`, [id]);
  if (!r[0]) throw new HttpError(404, "IMAGE_NOT_FOUND", "镜像不存在");
  return r[0];
}

// ---------- 执行 ----------
export async function listExecutions() {
  return rows(await pool.query("SELECT * FROM execution ORDER BY started_at DESC, id DESC"));
}

export async function createExecution(body) {
  const { rows: r } = await pool.query(
    `INSERT INTO execution(pipeline_id, run_no, status, trigger)
     VALUES($1, COALESCE((SELECT MAX(run_no)+1 FROM execution WHERE pipeline_id=$1),1), 'queued', $2::jsonb)
     RETURNING *`,
    [body?.pipelineId, JSON.stringify({ trigger: body?.trigger ?? null })]
  );
  return r[0];
}

export async function getExecution(id) {
  const { rows } = await pool.query(`SELECT * FROM execution WHERE id=$1`, [id]);
  if (!rows[0]) throw new HttpError(404, "EXECUTION_NOT_FOUND", "执行记录不存在");
  const { rows: steps } = await pool.query(
    `SELECT node_id, type, status, input, output, logs, started_at, finished_at FROM execution_node
      WHERE exec_id=$1 ORDER BY id`,
    [id]
  );
  // 附上节点配置快照：从所属 pipeline 最新 rev 的 spec 取 nodes，按 node_id 匹配把
  // name/type/params（命令、镜像、审批标题等）并入步骤，供详情页展示「哪个节点/在干什么」。
  const { rows: rev } = await pool.query(
    `SELECT p.spec_json FROM execution e
       JOIN pipeline_rev p ON p.pipeline_id = e.pipeline_id
      WHERE e.id = $1 ORDER BY p.rev DESC LIMIT 1`,
    [id]
  );
  const nodes = rev[0]?.spec_json?.nodes ?? [];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  // 并入节点在 spec 里的 position（画布优先用，没有则前端 layoutDag 自动布局；只读透出，不改库）
  const stepsWith = steps.map((s) => {
    const node = nodeMap.get(s.node_id);
    return node
      ? { ...s, name: node.name ?? "", params: node.params ?? {}, stepType: node.type, position: node.position }
      : s;
  });
  // 画布边：节点依赖边规约直通（{from,to} → 前端转 vf {source,target}）。rev 已在上方查出，不重复查库。
  const edges = rev[0]?.spec_json?.edges ?? [];
  // 调度日志：非节点执行日志，按时间正序
  const { rows: schedules } = await pool.query(
    `SELECT ts, message FROM execution_log WHERE exec_id=$1 ORDER BY id`,
    [id]
  );
  return { ...rows[0], steps: stepsWith, schedules, edges };
}

export async function executionPipelineId(id) {
  const { rows } = await pool.query(`SELECT pipeline_id FROM execution WHERE id=$1`, [id]);
  if (!rows[0]) throw new HttpError(404, "EXECUTION_NOT_FOUND", "执行记录不存在");
  return rows[0].pipeline_id;
}

// 取消/终止：仅排队或运行中的执行可取消；作废已派发的待回调 token，
// 并把未终结的节点标记为 cancelled，防止迟到回调续跑。
export async function cancelExecution(id) {
  const { rows } = await pool.query(
    `UPDATE execution SET status='cancelled', finished_at=now()
      WHERE id=$1 AND status IN ('queued','running') RETURNING *`,
    [id]
  );
  if (!rows[0]) {
    const chk = await pool.query(`SELECT id,status FROM execution WHERE id=$1`, [id]);
    if (!chk.rows[0]) throw new HttpError(404, "EXECUTION_NOT_FOUND", "执行记录不存在");
    throw new HttpError(409, "NOT_CANCELLABLE", "仅排队或运行中的执行可以被取消");
  }
  await pool.query(`DELETE FROM webhook_registry WHERE exec_id=$1`, [id]);
  await pool.query(
    `UPDATE execution_node SET status='cancelled', finished_at=now()
      WHERE exec_id=$1 AND status IN ('queued','running','dispatch','wait')`,
    [id]
  );
  return rows[0];
}