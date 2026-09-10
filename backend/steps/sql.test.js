import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSqlStep, buildOutput, coerceTimeout } from "./sql.js";
import { buildDbConfig, coerceExtraValue } from "../providers/db.js";
import { renderParams } from "../engine/variables.js";

// 内存 fake 连接：记录语句、行数；可注入失败点（begin/语句/commit）、回滚抛错、destroy 记录
function fakeConn({ failAt = null, rowsFor = {}, failBegin = false, failCommit = false, rollbackError = null } = {}) {
  const calls = [];
  return {
    calls,
    async begin() {
      calls.push("BEGIN");
      if (failBegin) throw new Error("simulated begin error");
    },
    async query(sql) {
      calls.push(sql);
      if (failAt !== null && calls.length - 1 === failAt + 1) { // 第 failAt(0 基) 条语句失败
        throw new Error("simulated db error");
      }
      return { rows: rowsFor[sql] ?? [], rowCount: 2, insertId: sql.startsWith("INSERT") ? 77 : null };
    },
    async commit() {
      calls.push("COMMIT");
      if (failCommit) throw new Error("simulated commit error");
    },
    async rollback() {
      calls.push("ROLLBACK");
      if (rollbackError) throw rollbackError;
    },
    async end() { calls.push("END"); },
    async destroy() { calls.push("DESTROY"); },
  };
}

const step = (conn, params, env) => {
  const s = makeSqlStep({
    getCredentialKind: async () => "mysql",
    getCredentialSecrets: async () => ({ host: "h", user: "u", password: "p", database: "d", extra: [] }),
    createConnection: async () => conn,
  });
  return s({ params, id: "n1" }, { execId: 1, environment: new Map(Object.entries(env ?? {})) });
};

test("多语句全部成功 → 提交、输出绑定、日志含各语句行数", async () => {
  const conn = fakeConn({ rowsFor: { "SELECT 1": [{ id: 9 }] } });
  const res = await step(conn, {
    credential: "c", timeout: 10,
    statements: ["UPDATE t SET a=1", "SELECT 1"],
    outputs: [{ key: "rows" }, { key: "first_id", column: "id" }],
  });
  assert.equal(res.kind, "done");
  assert.equal(res.output.rows, "2");
  assert.equal(res.output.first_id, "9");
  assert.ok(conn.calls.includes("BEGIN"));
  assert.ok(conn.calls.includes("COMMIT"));
  assert.deepEqual(res.logs.split("\n").length, 2);
  assert.ok(!conn.calls.includes("ROLLBACK"));
  assert.ok(conn.calls.includes("END"));
});

test("中途失败 → 回滚、回显已成功语句、抛含失败位置错误、连接已释放", async () => {
  const conn = fakeConn({ failAt: 1 }); // 第 2 条（0 基索引 1）失败，第 1 条成功可回显
  await assert.rejects(
    step(conn, { credential: "c", statements: ["UPDATE t SET a=1", "SELECT 1"], outputs: [] }),
    /第 2 条语句出错.*simulated db error/s
  );
  assert.ok(conn.calls.includes("ROLLBACK"));
  assert.deepEqual(conn.calls.filter((c) => c.match(/UPDATE|SELECT/) ), ["UPDATE t SET a=1", "SELECT 1"]);
  assert.ok(conn.calls.includes("END"));
});

test("开启事务失败 → 抛「开启事务失败」、连接已释放", async () => {
  const conn = fakeConn({ failBegin: true });
  await assert.rejects(
    step(conn, { credential: "c", statements: ["SELECT 1"], outputs: [] }),
    /开启事务失败.*simulated begin error/s
  );
  assert.ok(conn.calls.includes("END"));
});

test("提交失败 → 抛「提交事务出错」、回滚被调用", async () => {
  const conn = fakeConn({ failCommit: true });
  await assert.rejects(
    step(conn, { credential: "c", statements: ["UPDATE t SET a=1"], outputs: [] }),
    /提交事务出错.*simulated commit error/s
  );
  assert.ok(conn.calls.includes("ROLLBACK"));
  assert.ok(conn.calls.includes("END"));
});

test("回滚失败不掩盖原语句错误", async () => {
  const conn = fakeConn({ failAt: 0, rollbackError: new Error("rollback exploded") });
  const err = await step(conn, { credential: "c", statements: ["SELECT 1"], outputs: [] }).then(
    () => null,
    (e) => e
  );
  assert.ok(err, "应当抛出错误");
  assert.match(err.message, /第 1 条语句出错/);
  assert.match(err.message, /simulated db error/);
  assert.ok(!err.message.includes("rollback exploded"));
  assert.ok(conn.calls.includes("END"));
});

test("建连失败 → 错误含「连接数据库失败」与可读原因", async () => {
  const s = makeSqlStep({
    getCredentialKind: async () => "mysql",
    getCredentialSecrets: async () => ({ host: "h", user: "u", password: "p", database: "d" }),
    createConnection: async () => { throw new Error("ECONNREFUSED 127.0.0.1:3306"); },
  });
  await assert.rejects(
    s({ params: { credential: "c", statements: ["SELECT 1"], outputs: [] } }, { environment: new Map() }),
    /连接数据库失败.*ECONNREFUSED/s
  );
});

test("输出绑定：无 column → affectedRows；有 column → 首行该列；缺列 → 空串", async () => {
  assert.equal(buildOutput([{ key: "r" }], { rows: [], rowCount: 5 }).r, "5");
  assert.deepEqual(buildOutput([{ key: "x", column: "a" }, { key: "y", column: "missing" }], { rows: [{ a: "v1" }], rowCount: 1 }), { x: "v1", y: "" });
});

test("变量渲染：statements 内 ${var} 经 renderParams 替换后交给节点", async () => {
  const conn = fakeConn({ rowsFor: { "WHERE name = 张三": [] } });
  const rendered = renderParams(
    { credential: "c", statements: ["WHERE name = ${name}"], outputs: [{ key: "r" }] },
    new Map([["name", "张三"]])
  );
  const res = await step(conn, rendered);
  assert.deepEqual(conn.calls.filter((c) => c.includes("WHERE")), ["WHERE name = 张三"]);
  assert.equal(res.output.r, "2"); // fakeConn 固定 rowCount=2，无 column 输出绑定到 rowCount
});

test("凭证缺失 / 非 mysql|pg 类型 → 可读错误", async () => {
  const sNoKind = makeSqlStep({
    getCredentialKind: async () => "eci", getCredentialSecrets: async () => ({}),
    createConnection: async () => fakeConn(),
  });
  await assert.rejects(sNoKind({ params: { credential: "c", statements: ["SELECT 1"] } }, { environment: new Map() }), /不是数据库凭证/);
  await assert.rejects(step(fakeConn(), { credential: "", statements: ["SELECT 1"], outputs: [] }), /未选择数据库连接凭证/);
});

test("超时兜底：执行超过 timeout → destroy 断连（而非 rollback）、日志回显已成功语句", async () => {
  const conn = {
    calls: [],
    async begin() { this.calls.push("BEGIN"); },
    async query() { await new Promise((r) => setTimeout(r, 50)); return { rows: [], rowCount: 1 }; },
    async commit() { },
    async rollback() { this.calls.push("ROLLBACK"); },
    async destroy() { this.calls.push("DESTROY"); },
    async end() { this.calls.push("END"); },
  };
  await assert.rejects(
    step(conn, { credential: "c", timeout: 0.01, statements: ["SELECT 1", "SELECT 2"], outputs: [] }),
    /超时|失败/
  );
  assert.ok(conn.calls.includes("DESTROY"));
  assert.ok(!conn.calls.includes("ROLLBACK"));
  assert.ok(conn.calls.includes("END"));
});

test("buildDbConfig：固定字段直映射 + extra 类型化 + ssl 语义映射", () => {
  const cfg = buildDbConfig("mysql", {
    host: "h", port: 3307, user: "u", password: "p", database: "d",
    extra: [
      { key: "connectTimeout", value: "10000" },
      { key: "ssl", value: "true" },
      { key: "charset", value: "utf8mb4" },
      { key: "objects", value: '{"a":1}' },
    ],
  });
  assert.equal(cfg.host, "h");
  assert.equal(cfg.port, 3307);
  assert.equal(cfg.connectTimeout, 10000);   // 字符串数值 → number
  assert.equal(cfg.ssl, true);               // ssl=true → boolean
  assert.equal(cfg.charset, "utf8mb4");       // 普通串保留
  assert.deepEqual(cfg.objects, { a: 1 });     // JSON → object
  assert.equal(coerceExtraValue("false"), false);
  const pg = buildDbConfig("pg", { host: "h", user: "u", password: "p", database: "d", extra: [{ key: "ssl", value: "verify-ca" }] });
  assert.equal(pg.port, 5432);                // 默认端口
  assert.deepEqual(pg.ssl, { rejectUnauthorized: true });
  assert.equal(pg.connectionTimeoutMillis, 10000); // pg 默认建连超时
  const pgCustom = buildDbConfig("pg", { host: "h", user: "u", password: "p", database: "d", extra: [{ key: "connectionTimeoutMillis", value: "5000" }] });
  assert.equal(pgCustom.connectionTimeoutMillis, 5000); // 显式配置优先于默认
});

test("buildDbConfig：extra 不得覆盖保留键（host/port/user/password/database/multipleStatements）", () => {
  const cfg = buildDbConfig("mysql", {
    host: "real", port: 3306, user: "real_u", password: "real_p", database: "real_d",
    extra: [
      { key: "host", value: "evil.example.com" },
      { key: "port", value: "9999" },
      { key: "user", value: "evil_user" },
      { key: "password", value: "evil_p" },
      { key: "database", value: "evil_db" },
      { key: "multipleStatements", value: "true" },
    ],
  });
  assert.equal(cfg.host, "real");
  assert.equal(cfg.port, 3306);
  assert.equal(cfg.user, "real_u");
  assert.equal(cfg.password, "real_p");
  assert.equal(cfg.database, "real_d");
  assert.equal(cfg.multipleStatements, undefined);
});

test("coerceTimeout：秒 → 毫秒，非法 → undefined", () => {
  assert.equal(coerceTimeout(10), 10000);
  assert.equal(coerceTimeout("5"), 5000);
  assert.equal(coerceTimeout(0), undefined);
  assert.equal(coerceTimeout(undefined), undefined);
});
