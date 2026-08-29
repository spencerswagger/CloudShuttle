// backend/db/migrate.js —— 轻量 SQL 迁移器（golang-migrate / db-migrate 的同型替代）
// 约定：backend/db/migrations/NNN_name.sql 为迁移文件，按 NNN 升序仅应用一次；
// 用 schema_migrations 表记录已应用版本，事务内执行 + 落版，可安全重入。
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "../db/pg.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "migrations");

const client = await pool.connect();
try {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version     TEXT PRIMARY KEY,
       name        TEXT NOT NULL,
       applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  const { rows } = await client.query(`SELECT version FROM schema_migrations`);
  const applied = new Set(rows.map((r) => r.version));

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  let ran = 0;
  for (const file of files) {
    const version = file.split("_")[0];
    if (!version || applied.has(version)) continue;
    const sql = await fs.readFile(join(dir, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations(version, name) VALUES($1, $2)`, [version, file]);
      await client.query("COMMIT");
      console.log(`migration applied: ${file}`);
      ran += 1;
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${err?.message ?? err}`);
    }
  }
  console.log(ran ? `${ran} migration(s) applied` : "schema is up to date");
} finally {
  client.release();
  await pool.end();
}