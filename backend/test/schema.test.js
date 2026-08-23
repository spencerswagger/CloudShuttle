// backend/test/schema.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pg.js";
import { createPool } from "../db/pg.js";

test("credential 表可写入加密字段", async (t) => {
  // 用独立临时连接，避免污染启动连接
  const p = createPool();
  let c;
  try {
    c = await p.connect();
  } catch (err) {
    // 本机无 PG（或连接失败）时优雅跳过，避免整个 npm test 失败
    t.skip(`PG 不可用，跳过（${err.code ?? err.message}）`);
    await p.end();
    return;
  }
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS credential_stub (LIKE credential) INCLUDING ALL`);
    const r = await c.query(
      `INSERT INTO credential_stub(name, kind, secret_enc) VALUES($1,$2,$3) RETURNING id`,
      ["test", "docker-registry", "ENCRYPTED"]
    );
    assert.ok(r.rows[0].id);
  } finally {
    c.release();
    await p.end();
  }
});