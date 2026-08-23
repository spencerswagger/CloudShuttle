// backend/handlers/api.js —— /api/* 管道/凭证/镜像/执行 CRUD
// 全程使用 db/pg.js 的 pool 直接执行 SQL（列名对齐 db/schema.sql）；
// 凭证写入时用 crypto/sm4.js 的 SM4 加密后再入库。
import { pool } from "../db/pg.js";
import { config } from "../config.js";
import { sm4Encrypt } from "../crypto/sm4.js";

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
  return rows(await pool.query("SELECT * FROM pipeline ORDER BY id"));
}

export async function createPipeline(body) {
  const spec = JSON.stringify(body?.spec_json ?? {});
  const { rows: r } = await pool.query(
    `INSERT INTO pipeline(name, description, spec_json) VALUES($1,$2,$3::jsonb) RETURNING *`,
    [body?.name, body?.description ?? null, spec]
  );
  await snapshotRev(r[0].id, 1, spec);
  return r[0];
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
    throw new Error(
      "SM4_KEY not configured; cannot store secrets. Set SM4_KEY (16-byte hex) before creating credentials."
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