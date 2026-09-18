// backend/db/migrate.js —— 轻量 SQL 迁移器（golang-migrate / db-migrate 的同型替代）
// 约定：backend/db/migrations/NNN_name.sql 为迁移文件，按 NNN 升序仅应用一次；
// 用 schema_migrations 表记录已应用版本，事务内执行 + 落版，可安全重入。
//
// 两种用法：
//   1. 程序化（推荐）：后端启动时自动执行 —— index.js buildApp() 首个请求前调用
//      runMigrations({ pool })，FC 函数代码模式与自定义容器（local-server.js → handler）均覆盖；
//   2. CLI：`node backend/db/migrate.js` 仍可用（手动触发，幂等，无副作用）。
//
// 并发安全：pg_advisory_lock 固定键串行化跨实例迁移（FC 多实例同时冷启动时只由一个执 DDL）。
import { promises as fs } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { pool as defaultPool } from "./pg.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "migrations");

// advisory lock 固定键（跨实例互斥迁移；int8 取值，避免与业务锁冲突）
const MIGRATE_LOCK_KEY = "8642097531";

/**
 * 应用未执行的迁移（幂等）：已在 schema_migrations 记录的 NNN 永远不重跑。
 * @param {{ pool?: typeof defaultPool }} [opts]
 * @returns {Promise<number>} 本次实际应用的迁移数
 */
export async function runMigrations({ pool = defaultPool } = {}) {
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    // 连接不可达（本地无 PG / 测试 mock 池无真实连接）：抛出可区分的错误，
    // 由调用方决定降级；迁移文件执行失败则始终硬失败。
    throw new Error(`db_unreachable: ${err?.message ?? err}`);
  }
  try {
    // 跨实例/跨启动串行：持有全局锁期间完成 DDL，其余并发启动者等待
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATE_LOCK_KEY]);
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
    if (ran) console.log(`${ran} migration(s) applied`);
    return ran;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATE_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

// CLI 直接执行：node backend/db/migrate.js
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  try {
    const ran = await runMigrations({ pool: defaultPool });
    console.log(ran ? `${ran} migration(s) applied` : "schema is up to date");
  } finally {
    await defaultPool.end();
  }
}