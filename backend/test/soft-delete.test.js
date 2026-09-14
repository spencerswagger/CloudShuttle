// backend/test/soft-delete.test.js —— 软删除回归：删除接口由物理 DELETE 改为 deleted_at 标记。
// 覆盖线上事故：原 deletePipeline 物理删除会因 execution_log 外键（execution_log_exec_id_fkey）
// 违反约束而 500；软删除后历史执行/日志全量保留，且支持删除后同名重建（部分唯一索引）。
// 真 DB 可用才跑（沿用 schema.test.js 的 skip 约定），用后清理测试数据。
import { test } from "node:test";
import assert from "node:assert/strict";
import { pool, createPool } from "../db/pg.js";
import {
  createPipeline, deletePipeline, getPipeline, listPipelines,
  deleteCredential, listCredentials,
  createImage, deleteImage, listImages,
} from "../handlers/api.js";
import { resolvePipelineByName } from "../handlers/hook.js";

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const NAMES = {
  pipeline: `softdel_p_${suffix}`,
  pipeline2: `softdel_p2_${suffix}`,
  credential: `softdel_c_${suffix}`,
  image: `softdel_i_${suffix}`,
};

// 清理：先子表后父表（execution 引用 pipeline），并按 name 物理删掉测试行（含软删残留）
async function cleanup(p, names = NAMES) {
  await p.query(
    `DELETE FROM execution_log WHERE exec_id IN (SELECT id FROM execution WHERE pipeline_id IN (SELECT id FROM pipeline WHERE name = ANY($1)))`,
    [Object.values(names)]
  );
  await p.query(
    `DELETE FROM execution WHERE pipeline_id IN (SELECT id FROM pipeline WHERE name = ANY($1))`,
    [Object.values(names)]
  );
  await p.query(
    `DELETE FROM pipeline_rev WHERE pipeline_id IN (SELECT id FROM pipeline WHERE name = ANY($1))`,
    [Object.values(names)]
  );
  await p.query(`DELETE FROM pipeline WHERE name = ANY($1)`, [Object.values(names)]);
  await p.query(`DELETE FROM credential WHERE name = ANY($1)`, [Object.values(names)]);
  await p.query(`DELETE FROM exec_image WHERE name = ANY($1)`, [Object.values(names)]);
}

test("删除流水线不再因 execution_log 外键失败，且历史执行/日志全量保留", async (t) => {
  const p = createPool();
  let c;
  try {
    c = await p.connect();
  } catch (err) {
    t.skip(`PG 不可用，跳过（${err.code ?? err.message}）`);
    await p.end();
    return;
  }
  try {
    // 造流水线 + 一条执行 + 一条调度日志（原事故现场：execution_log 引用 execution）
    const pipe = await createPipeline({ name: NAMES.pipeline, description: "soft-delete", spec_json: { nodes: [], edges: [] } });
    const { rows: [ex] } = await c.query(
      `INSERT INTO execution(pipeline_id, run_no, status) VALUES($1, 1, 'completed') RETURNING id`,
      [pipe.id]
    );
    await c.query(`INSERT INTO execution_log(exec_id, message) VALUES($1, 'probe log')`, [ex.id]);

    // 核心回归：deletePipeline 不得抛外键错误（旧实现此处 500）
    const del = await deletePipeline(pipe.id);
    assert.ok(del?.id, "deletePipeline 应返回被删 id");

    // 列表不再出现，详情 404
    const listed = await listPipelines();
    assert.ok(!listed.some((x) => x.id === pipe.id), "已删流水线不得出现在列表");
    await assert.rejects(getPipeline(pipe.id), (e) => e.code === "PIPELINE_NOT_FOUND", "已删流水线详情必须 404");

    // 行仍在（软删除标记），历史执行与日志完好
    const { rows: [row] } = await c.query(`SELECT id, deleted_at FROM pipeline WHERE id=$1`, [pipe.id]);
    assert.ok(row, "流水线行必须保留（软删除）");
    assert.ok(row.deleted_at, "deleted_at 必须被打上");
    const { rows: logs } = await c.query(`SELECT message FROM execution_log WHERE exec_id=$1`, [ex.id]);
    assert.deepEqual(logs, [{ message: "probe log" }], "执行日志必须保留");

    // webhook 定位：已删流水线不可再触发
    await assert.rejects(resolvePipelineByName(NAMES.pipeline), /pipeline not found/);
  } finally {
    await cleanup(c);
    c.release();
    await p.end();
  }
});

test("删除后可用同名重建（name 唯一约束改为活跃行部分唯一索引）", async (t) => {
  const p = createPool();
  let c;
  try {
    c = await p.connect();
  } catch (err) {
    t.skip(`PG 不可用，跳过（${err.code ?? err.message}）`);
    await p.end();
    return;
  }
  try {
    const a = await createPipeline({ name: NAMES.pipeline2, description: "first", spec_json: { nodes: [], edges: [] } });
    await deletePipeline(a.id);
    const b = await createPipeline({ name: NAMES.pipeline2, description: "recreated", spec_json: { nodes: [], edges: [] } });
    assert.ok(b.id && b.id !== a.id, "软删除后同名重建必须成功");
  } finally {
    await cleanup(c);
    c.release();
    await p.end();
  }
});

test("凭证/镜像删除改为软删除：列表不可见，同名可重建", async (t) => {
  const p = createPool();
  let c;
  try {
    c = await p.connect();
  } catch (err) {
    t.skip(`PG 不可用，跳过（${err.code ?? err.message}）`);
    await p.end();
    return;
  }
  try {
    // 凭证（绕过 createCredential，避免依赖 SM4 配置，直接落库）
    const { rows: [cred] } = await c.query(
      `INSERT INTO credential(name, kind, secret_enc) VALUES($1,'pg','ENC') RETURNING id`,
      [NAMES.credential]
    );
    await deleteCredential(cred.id);
    assert.ok(!(await listCredentials()).some((x) => x.id === cred.id), "已删凭证不得出现在列表");
    const { rows: [credRow] } = await c.query(`SELECT deleted_at FROM credential WHERE id=$1`, [cred.id]);
    assert.ok(credRow.deleted_at, "凭证 deleted_at 必须被打上");
    // 同名重建（部分唯一索引生效）
    const { rows: [cred2] } = await c.query(
      `INSERT INTO credential(name, kind, secret_enc) VALUES($1,'pg','ENC') RETURNING id`,
      [NAMES.credential]
    );
    assert.ok(cred2.id !== cred.id, "凭证软删除后可同名重建");

    // 镜像
    const img = await createImage({ name: NAMES.image, image: "alpine:3.20", category: "通用" });
    await deleteImage(img.id);
    assert.ok(!(await listImages()).some((x) => x.id === img.id), "已删镜像不得出现在列表");
    const { rows: [imgRow] } = await c.query(`SELECT deleted_at FROM exec_image WHERE id=$1`, [img.id]);
    assert.ok(imgRow.deleted_at, "镜像 deleted_at 必须被打上");
  } finally {
    await cleanup(c);
    c.release();
    await p.end();
  }
});
