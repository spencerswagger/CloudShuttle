// backend/handlers/api.js —— /api/* 管道/凭证/镜像/执行 CRUD
// 全程使用 db/pg.js 的 pool 直接执行 SQL（列名对齐 db/migrations/*.sql）；
// 凭证写入时用 crypto/sm4.js 的 SM4 加密后再入库。
import { pool } from "../db/pg.js";
import { config } from "../config.js";
import { sm4Encrypt, sm4Decrypt } from "../crypto/sm4.js";
import { HttpError } from "../errors.js";
import { randomUUID } from "node:crypto";
import { checkVars, resolveScope } from "../engine/variables.js";
import { buildGraph, ancestors } from "../engine/dag.js";

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

// 把当前 spec 对应版本登记进 pipeline_rev（历史版本表）
async function snapshotRev(pipelineId, rev, spec) {
  await pool.query(
    `INSERT INTO pipeline_rev(pipeline_id, rev, spec_json) VALUES($1,$2,$3::jsonb)`,
    [pipelineId, rev, spec]
  );
}

// ---------- 管道 ----------
export async function listPipelines() {
  // webhook_secret 属敏感字段，仅能经 get/reset 接口显式获取
  return rows(
    await pool.query(`SELECT id, name, description, spec_json, rev, created_at, updated_at FROM pipeline ORDER BY id`)
  );
}

// 详情（编辑返显用）：单条流水线，含完整 spec_json
export async function getPipeline(id) {
  const { rows } = await pool.query(
    `SELECT id, name, description, spec_json, rev, created_at, updated_at FROM pipeline WHERE id=$1`,
    [id]
  );
  if (!rows[0]) throw new HttpError(404, "PIPELINE_NOT_FOUND", "流水线不存在");
  return rows[0];
}

export async function createPipeline(body) {
  const specObj = resolveSpec(body);
  assertVarsResolved(specObj);
  const spec = JSON.stringify(specObj);
  // 每条管道的 webhook 触发独立密钥，创建时生成并存库
  const webhookSecret = randomUUID();
  const { rows: r } = await pool.query(
    `INSERT INTO pipeline(name, description, spec_json, webhook_secret) VALUES($1,$2,$3::jsonb,$4) RETURNING *`,
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
    `SELECT name, webhook_secret FROM pipeline WHERE id=$1`,
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
    `UPDATE pipeline SET webhook_secret=$2 WHERE id=$1 RETURNING name`,
    [id, secret]
  );
  if (!r[0]) return null;
  return { ok: true, id, name: r[0].name, secret, url: buildWebhookUrl({ base, name: r[0].name, secret }) };
}

// 调试探针：该管道最近一次 webhook 投递的原始 body（无记录时 body/receivedAt 均为 null）
export async function getWebhookProbe(id) {
  const { rows } = await pool.query(
    `SELECT body, received_at FROM webhook_probe WHERE pipeline_id=$1`,
    [id]
  );
  const row = rows[0];
  return {
    ok: true,
    body: row?.body ?? null,
    receivedAt: row?.received_at ? new Date(row.received_at).toISOString() : null,
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

export async function updatePipeline(id, body) {
  const specObj = resolveSpec(body);
  assertVarsResolved(specObj);
  const spec = JSON.stringify(specObj);
  const { rows: r } = await pool.query(
    `UPDATE pipeline SET spec_json=$2::jsonb, rev=rev+1, updated_at=now() WHERE id=$1 RETURNING *`,
    [id, spec]
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

export async function deletePipeline(id) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM webhook_registry WHERE exec_id IN (SELECT id FROM execution WHERE pipeline_id=$1)`, [id]);
    await client.query(
      `DELETE FROM execution_node WHERE exec_id IN (SELECT id FROM execution WHERE pipeline_id=$1)`, [id]);
    await client.query(`DELETE FROM execution WHERE pipeline_id=$1`, [id]);
    await client.query(`DELETE FROM pipeline_rev WHERE pipeline_id=$1`, [id]);
    const { rows: r } = await client.query(`DELETE FROM pipeline WHERE id=$1 RETURNING id`, [id]);
    await client.query("COMMIT");
    return rows({ rows: r })[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function deleteCredential(id) {
  const { rows: r } = await pool.query(
    `DELETE FROM credential WHERE id=$1 RETURNING id,name`, [id]);
  return rows({ rows: r })[0];
}

// ---------- 凭证（不回显 secret_enc 明文） ----------
export async function listCredentials() {
  return rows(
    await pool.query(`SELECT id, name, kind, display_meta, created_at FROM credential ORDER BY id`)
  );
}

// 详情（编辑返显用）：不回显 secret_enc 明文
export async function getCredential(id) {
  const { rows } = await pool.query(
    `SELECT id, name, kind, display_meta, created_at FROM credential WHERE id=$1`, [id]
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
    const { rows: cur } = await pool.query(`SELECT secret_enc FROM credential WHERE id=$1`, [id]);
    const orig = cur[0] ? sm4Decrypt(config.sm4Key, cur[0].secret_enc) : {};
    // 敏感项留空则沿用原值；校验并复用原 routeKey 重新注册（forceUpdate 覆盖），并刷新展示信息
    const merged = { ...orig, ...(body?.secret && typeof body.secret === "object" ? body.secret : {}) };
    const r = await enrollDingtalk(merged, merged.cardCallbackRouteKey, deps);
    const enc = sm4Encrypt(config.sm4Key, r.secret);
    const { rows: rr } = await pool.query(
      `UPDATE credential SET name=$2, secret_enc=$3, display_meta=$4::jsonb, updated_at=now() WHERE id=$1 RETURNING id,name,kind`,
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
    ? `UPDATE credential SET name=$2, secret_enc=$3, updated_at=now() WHERE id=$1 RETURNING id,name,kind`
    : `UPDATE credential SET name=$2, updated_at=now() WHERE id=$1 RETURNING id,name,kind`;
  const args = enc ? [id, body?.name, enc] : [id, body?.name];
  const { rows: r } = await pool.query(sql, args);
  if (!r[0]) throw new HttpError(404, "CREDENTIAL_NOT_FOUND", "凭证不存在");
  return r[0];
}

// ---------- 镜像 ----------
export async function listImages() {
  return rows(await pool.query("SELECT * FROM exec_image ORDER BY category,id"));
}

// 详情（编辑返显用）
export async function getImage(id) {
  const { rows } = await pool.query(`SELECT * FROM exec_image WHERE id=$1`, [id]);
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
    `UPDATE exec_image SET name=$2, image=$3, category=$4 WHERE id=$1 RETURNING *`,
    [id, body?.name, body?.image, body?.category ?? "通用"]
  );
  if (!r[0]) throw new HttpError(404, "IMAGE_NOT_FOUND", "镜像不存在");
  return r[0];
}

export async function deleteImage(id) {
  const { rows: r } = await pool.query(`DELETE FROM exec_image WHERE id=$1 RETURNING id`, [id]);
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
  return rows[0];
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