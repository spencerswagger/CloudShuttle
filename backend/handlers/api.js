// backend/handlers/api.js —— /api/* 管道/凭证/镜像/执行 CRUD
// 全程使用 db/pg.js 的 pool 直接执行 SQL（列名对齐 db/schema.sql）；
// 凭证写入时用 crypto/sm4.js 的 SM4 加密后再入库。
import { pool } from "../db/pg.js";
import { config } from "../config.js";
import { sm4Encrypt } from "../crypto/sm4.js";
import { HttpError } from "../errors.js";
import { randomUUID } from "node:crypto";

const rows = (r) => r.rows;

// 把当前 spec 对应版本登记进 pipeline_rev（历史版本表）
async function snapshotRev(pipelineId, rev, spec) {
  await pool.query(
    `INSERT INTO pipeline_rev(pipeline_id, rev, spec_json) VALUES($1,$2,$3::jsonb)`,
    [pipelineId, rev, spec]
  );
}

// ---------- 管道 ----------
export async function listPipelines() {
  // git_hook_secret 属敏感字段，仅能经 get/reset 接口显式获取
  return rows(
    await pool.query(`SELECT id, name, description, spec_json, rev, created_at, updated_at FROM pipeline ORDER BY id`)
  );
}

export async function createPipeline(body) {
  const spec = JSON.stringify(body?.spec_json ?? {});
  // 每个 git 仓库 hook 独立密钥，创建时生成并存库
  const gitHookSecret = randomUUID();
  const { rows: r } = await pool.query(
    `INSERT INTO pipeline(name, description, spec_json, git_hook_secret) VALUES($1,$2,$3::jsonb,$4) RETURNING *`,
    [body?.name, body?.description ?? null, spec, gitHookSecret]
  );
  await snapshotRev(r[0].id, 1, spec);
  return r[0];
}

// 查看/生成该管道的 git hook 密钥（懒生成：为空则补一个）
export async function getGitHookSecret(id) {
  const { rows: r } = await pool.query(
    `SELECT git_hook_secret FROM pipeline WHERE id=$1`,
    [id]
  );
  if (!r[0]) return null;
  let secret = r[0].git_hook_secret;
  if (!secret) {
    secret = randomUUID();
    await pool.query(`UPDATE pipeline SET git_hook_secret=$2 WHERE id=$1`, [id, secret]);
  }
  return { id, gitHookSecret: secret };
}

// 重置 git hook 密钥（泄露或轮换用）
export async function resetGitHookSecret(id) {
  const secret = randomUUID();
  const { rows: r } = await pool.query(
    `UPDATE pipeline SET git_hook_secret=$2 WHERE id=$1 RETURNING id`,
    [id, secret]
  );
  if (!r[0]) return null;
  return { id, gitHookSecret: secret };
}

export async function updatePipeline(id, body) {
  const spec = JSON.stringify(body?.spec_json ?? {});
  const { rows: r } = await pool.query(
    `UPDATE pipeline SET spec_json=$2::jsonb, rev=rev+1, updated_at=now() WHERE id=$1 RETURNING *`,
    [id, spec]
  );
  if (r[0]) await snapshotRev(id, r[0].rev, spec);
  return r[0];
}

export async function deletePipeline(id) {
  const { rows: r } = await pool.query(`DELETE FROM pipeline WHERE id=$1 RETURNING id`, [id]);
  return rows({ rows: r })[0];
}

// ---------- 凭证（不回显 secret_enc 明文） ----------
export async function listCredentials() {
  return rows(
    await pool.query(`SELECT id, name, kind, created_at FROM credential ORDER BY id`)
  );
}

export async function createCredential(body) {
  if (!config.sm4Key) {
    throw new HttpError(
      500,
      "SERVICE_MISCONFIG",
      "系统加解密配置缺失，请联系管理员处理",
      "SM4_KEY not configured in control plane env; secret cannot be stored",
    );
  }
  const enc = sm4Encrypt(config.sm4Key, body?.secret ?? {});
  const { rows: r } = await pool.query(
    `INSERT INTO credential(name, kind, secret_enc) VALUES($1,$2,$3) RETURNING id,name,kind`,
    [body?.name, body?.kind, enc]
  );
  return r[0];
}

// ---------- 镜像 ----------
export async function listImages() {
  return rows(await pool.query("SELECT * FROM exec_image ORDER BY category,id"));
}

export async function createImage(body) {
  const { rows: r } = await pool.query(
    `INSERT INTO exec_image(name, image, category, builtin) VALUES($1,$2,$3,$4) RETURNING *`,
    [body?.name, body?.image, body?.category, body?.builtin ?? false]
  );
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