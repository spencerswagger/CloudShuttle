# SQL 执行节点 + 数据库连接凭证 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `sql` 节点（后端直连、单事务逐条执行多条 SQL，结果按 `outputs[].key` 写回变量总线）与 `mysql`/`pg` 两类数据库连接凭证（固定字段 + 自定义额外参数 + 测试连接端点）。

**Architecture:** SQL 节点复用 `createAdvancer` 的 `{ kind:'done', output }` 同步完成契约，`stepRun` 内建连→BEGIN→逐条执行→COMMIT/失败回滚，`output + logs` 由调度器写回 environment 与 execution_node。凭证沿用 CRED_KINDS 模式，`extra` 键值对在提供商层 `buildDbConfig` 统一合并进驱动 config。测试连接端点复用 eciProbeNetworks 的「200 + {ok:false,message}」降级模式。

**Tech Stack:** Node ESM、`pg`（已有）、`mysql2`（新增）、Vue 3 + Vite（前端）、SM4 加密（凭证）。

**Spec:** `docs/superpowers/specs/2026-09-10-sql-node-and-db-credential-design.md`

**本地运行约束（项目 AGENTS.md）：** 本机 macOS 系统 node 不可用，所有后端命令须 `PATH="/usr/local/bin:$PATH" node ...`。

---

## Task 1: 后端新增 `mysql2` 依赖

**Files:**
- Modify: `backend/package.json:20`（在 pg 条目后追加）

- [ ] **Step 1: 在依赖中追加 mysql2**

在 `backend/package.json` 的 dependencies 里、`"pg": "^8.11.0",` 之后插入一行：

```json
    "mysql2": "^3.11.0",
```

- [ ] **Step 2: 安装依赖**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/backend && PATH="/usr/local/bin:$PATH" npm install mysql2@^3.11.0`
Expected: 成功安装，`node_modules/mysql2` 存在，`package.json` 出现 `"mysql2": "^3.x.x"`。

- [ ] **Step 3: Commit**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline && git add backend/package.json backend/package-lock.json && git commit -m "chore(deps): 新增 mysql2 驱动支持 SQL 节点"
```

---

## Task 2: 新增 `backend/providers/db.js`（建连代理 + extra 合并）

**Files:**
- Create: `backend/providers/db.js`

统一 mysql(2) / pg 建连与查询返回形状；纯函数 `buildDbConfig` 负责把固定字段 + `extra` 合并成驱动 config（便于单测）。

- [ ] **Step 1: 创建 providers/db.js（完整内容）**

```js
// 数据库连接代理：统一 mysql(2)/pg 的建连与查询返回形状，屏蔽驱动差异。
// buildDbConfig 是纯函数（固定字段 + extra 合并、类型化、ssl 语义映射），可独立单测。
import pg from "pg";
import mysql from "mysql2/promise";

// 值轻量类型化：数值 / 'true'|'false' / JSON，否则保留字符串。
// 让 connectTimeout=10000、statement_timeout=5000、ssl=true 等可直接作普通自定义项。
export function coerceExtraValue(v) {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (s === "") return s;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  const lower = s.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  try { return JSON.parse(s); } catch { return s; }
}

// ssl 语义串 → 驱动可用的 ssl 配置（布尔或对象）；未命中的字符串回退给 coerceExtraValue。
const SSL_MODE_MAP = {
  "true": true,
  "false": false,
  "disable": false,
  "require": { rejectUnauthorized: false },
  "verify-ca": { rejectUnauthorized: true },
};

// 纯函数：把解密后的凭证对象 → 驱动 config。
// secret 形如 { host, port?, user, password, database, extra?: [{key,value}] }
export function buildDbConfig(kind, secret) {
  const portDefault = kind === "pg" ? 5432 : 3306;
  const cfg = {
    host: secret?.host,
    port: Number(secret?.port ?? portDefault),
    user: secret?.user,
    password: secret?.password,
    database: secret?.database,
  };
  for (const item of Array.isArray(secret?.extra) ? secret.extra : []) {
    const k = item?.key;
    const v = item?.value;
    if (!k) continue;
    if (k === "ssl") cfg.ssl = SSL_MODE_MAP[String(v).toLowerCase()] ?? coerceExtraValue(v);
    else cfg[k] = coerceExtraValue(v);
  }
  return cfg;
}

async function openPg(cfg) {
  const client = new pg.Client(cfg);
  await client.connect();
  return {
    async begin() { await client.query("BEGIN"); },
    async query(sql) {
      const r = await client.query(sql);
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? 0, insertId: null };
    },
    async commit() { await client.query("COMMIT"); },
    async rollback() { await client.query("ROLLBACK"); },
    async end() { await client.end(); },
  };
}

async function openMysql(cfg) {
  // 不支持 multipleStatements；事务由 BEGIN/COMMIT 手工管理，语句逐条下发
  const conn = await mysql.createConnection(cfg);
  return {
    async begin() { await conn.query("START TRANSACTION"); },
    async query(sql) {
      const [results] = await conn.query(sql);
      // SELECT → rows 数组；写语句 → OkPacket（含 affectedRows/insertId）
      return {
        rows: Array.isArray(results) ? results : [],
        rowCount: results?.affectedRows ?? (Array.isArray(results) ? results.length : 0),
        insertId: results?.insertId ?? null,
      };
    },
    async commit() { await conn.commit(); },
    async rollback() { await conn.rollback(); },
    async end() { await conn.end(); },
  };
}

// 按 kind 打开一条连接；不支持的 kind 抛可读错误。
export async function createConnection(kind, secret) {
  const cfg = buildDbConfig(kind, secret);
  if (kind === "pg") return openPg(cfg);
  if (kind === "mysql") return openMysql(cfg);
  throw new Error(`不支持的数据库类型：${kind}`);
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline && git add backend/providers/db.js && git commit -m "feat(db): 统一 mysql/pg 建连代理与 extra 参数合并"
```

---

## Task 3: 新增 `backend/steps/sql.js`（SQL 节点 stepRun）

**Files:**
- Create: `backend/steps/sql.js`

在单事务内逐条执行 `statements`，成功提交、失败回滚并回显已成功语句，输出按 `outputs[].key` 绑定。

- [ ] **Step 1: 创建 steps/sql.js（完整内容）**

```js
// SQL 节点的 stepRun 实现：后端直连数据库，单事务内逐条执行多条语句。
// 任一语句失败：回显已成功语句 → 回滚 → 抛含失败位置的错误，绝不让连接悬挂。
export function coerceTimeout(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n * 1000 : undefined; // 秒 → 毫秒
}

function withTimeout(promise, ms, message) {
  if (!ms) return promise;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

function readableError(err) {
  return String(err?.message ?? err).split("\n")[0].slice(0, 300);
}

// 输出绑定：无 column → 最后一条语句的受影响/返回行数；有 column → 最后结果集首行该列。
export function buildOutput(outputs, lastResult) {
  const out = {};
  const first = (lastResult?.rows?.[0] ?? {});
  for (const o of Array.isArray(outputs) ? outputs : []) {
    const key = o?.key;
    if (!key) continue;
    if (o?.column) {
      const v = first[o.column];
      out[key] = v === undefined ? "" : String(v);
    } else {
      out[key] = String(lastResult?.rowCount ?? 0);
    }
  }
  return out;
}

// 依赖注入：getCredentialKind/getCredentialSecrets 沿 shell/approval 既有模式注入；createConnection 由 providers/db 提供。
export function makeSqlStep({ getCredentialKind, getCredentialSecrets, createConnection }) {
  return async function sqlStep(node, ctx) {
    const p = node.params;
    const credential = p?.credential;
    if (!credential) throw new Error("SQL 节点未选择数据库连接凭证");
    const kind = await getCredentialKind(credential);
    if (kind !== "mysql" && kind !== "pg") {
      throw new Error(`凭证 "${credential}" 不是数据库凭证（当前类型：${kind || "未找到"}），请选择 mysql/pg 类型凭证`);
    }
    const secret = await getCredentialSecrets(credential);
    const statements = (Array.isArray(p?.statements) ? p.statements : [])
      .map((s) => String(s ?? "").trim())
      .filter(Boolean);
    if (!statements.length) throw new Error("SQL 节点未填写任何可执行的 SQL 语句");

    const timeoutMs = coerceTimeout(p?.timeout);
    const conn = await createConnection(kind, secret);
    const logs = [];
    let succeeded = 0;
    let lastResult = { rows: [], rowCount: 0, insertId: null };
    try {
      await withTimeout(conn.begin(), timeoutMs, "SQL 节点开启事务超时");
      for (const stmt of statements) {
        const r = await conn.query(stmt);
        lastResult = r;
        succeeded++;
        logs.push(
          `✓ ${succeeded}. 执行成功（影响/返回 ${r.rowCount} 行${r.insertId != null ? `，自增 id=${r.insertId}` : ""}）`
        );
      }
      await withTimeout(conn.commit(), timeoutMs, "SQL 节点提交事务超时");
    } catch (err) {
      try { await conn.rollback(); } catch { /* 回滚失败不掩盖原错误 */ }
      const where = succeeded < statements.length ? `第 ${succeeded + 1} 条语句出错` : "提交事务出错";
      const readback = logs.length ? `；已成功执行 ${succeeded} 条：\n` + logs.join("\n") : "；无已成功语句";
      throw new Error(`SQL 节点执行失败：${where}${readback}\n原因：${readableError(err)}`);
    } finally {
      try { await conn.end(); } catch { /* 忽略关闭错误 */ }
    }
    return { kind: "done", output: buildOutput(p?.outputs, lastResult), logs: logs.join("\n") };
  };
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline && git add backend/steps/sql.js && git commit -m "feat(sql): SQL 节点 stepRun（单事务逐条执行 + 回滚回读 + 输出绑定）"
```

---

## Task 4: `backend/engine/state.js` 让 `res.logs` 落入节点记录

**Files:**
- Modify: `backend/engine/state.js:67`（done 分支的 `record(...)` 调用）

- [ ] **Step 1: 把 `res.logs` 传给 record**

将第 67 行：

```js
await record({ execId, nodeId, status: "done", output: res.output });
```

改为：

```js
await record({ execId, nodeId, status: "done", output: res.output, logs: res.logs });
```

说明：`backend/index.js` 的 `writeNodeRecord` 已支持 `logs` 列；此改动让同步完成类节点（如 SQL）把结构化日志写入 `execution_node.logs` 供执行详情展示。`logs` 为 `undefined` 时 `writeNodeRecord` 用 `logs ?? null` 兜底，兼容存量节点与既有用例。

- [ ] **Step 2: 跑既有引擎测试确认无回归**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/backend && PATH="/usr/local/bin:$PATH" node --test engine test/`
Expected: 全部 PASS（`record` fake 忽略多余字段，无破坏）。

- [ ] **Step 3: Commit**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline && git add backend/engine/state.js && git commit -m "feat(engine): 同步完成节点把 logs 写入节点记录"
```

---

## Task 5: SQL 步骤与建连代理单元测试

**Files:**
- Create: `backend/steps/sql.test.js`

用 fake `createConnection` 驱动 `makeSqlStep`，覆盖成功/回滚/输出绑定/凭证错误/超时；`buildDbConfig` 用例直接验证 extra 合并。

- [ ] **Step 1: 创建 sql.test.js（完整内容）**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSqlStep, buildOutput, coerceTimeout } from "./sql.js";
import { buildDbConfig, coerceExtraValue } from "../providers/db.js";
import { renderParams } from "../engine/variables.js";

// 内存 fake 连接：记录语句、行数；可注入失败点与回滚吞错行为
function fakeConn({ failAt = null, rowsFor = {} } = {}) {
  const calls = [];
  let inTx = false;
  return {
    calls,
    async begin() { inTx = true; calls.push("BEGIN"); },
    async query(sql) {
      calls.push(sql);
      if (failAt !== null && calls.length - 1 === failAt + 1) { // 第 failAt(0 基) 条语句失败
        const e = new Error("simulated db error");
        throw e;
      }
      return { rows: rowsFor[sql] ?? [], rowCount: 2, insertId: sql.startsWith("INSERT") ? 77 : null };
    },
    async commit() { calls.push("COMMIT"); },
    async rollback() { calls.push("ROLLBACK"); },
    async end() { calls.push("END"); },
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
  const conn = fakeConn({ failAt: 0 }); // 第 1 条失败
  await assert.rejects(
    step(conn, { credential: "c", statements: ["UPDATE t SET a=1", "SELECT 1"], outputs: [] }),
    /第 2 条语句出错.*ID.*simulated db error/s
  );
  assert.ok(conn.calls.includes("ROLLBACK"));
  assert.deepEqual(conn.calls.filter((c) => c.match(/UPDATE|SELECT/) ), ["UPDATE t SET a=1"]);
  assert.ok(conn.calls.includes("END"));
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
  assert.equal(res.output.r, "0");
});

test("凭证缺失 / 非 mysql|pg 类型 → 可读错误", async () => {
  const sNoKind = makeSqlStep({
    getCredentialKind: async () => "eci", getCredentialSecrets: async () => ({}),
    createConnection: async () => fakeConn(),
  });
  await assert.rejects(sNoKind({ params: { credential: "c", statements: ["SELECT 1"] } }, { environment: new Map() }), /不是数据库凭证/);
  await assert.rejects(step(fakeConn(), { credential: "", statements: ["SELECT 1"], outputs: [] }), /未选择数据库连接凭证/);
});

test("超时兜底：执行超过 timeout → 失败并回滚、日志回显已成功语句", async () => {
  const conn = {
    calls: [], inTx: true,
    async begin() { this.calls.push("BEGIN"); },
    async query() { await new Promise((r) => setTimeout(r, 50)); return { rows: [], rowCount: 1 }; },
    async commit() { },
    async rollback() { this.calls.push("ROLLBACK"); },
    async end() { this.calls.push("END"); },
  };
  await assert.rejects(
    step(conn, { credential: "c", timeout: 0.01, statements: ["SELECT 1", "SELECT 2"], outputs: [] }),
    /超时|失败/
  );
  assert.ok(conn.calls.includes("ROLLBACK"));
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
});

test("coerceTimeout：秒 → 毫秒，非法 → undefined", () => {
  assert.equal(coerceTimeout(10), 10000);
  assert.equal(coerceTimeout("5"), 5000);
  assert.equal(coerceTimeout(0), undefined);
  assert.equal(coerceTimeout(undefined), undefined);
});
```

注意：`出「第 m 条失败」` 断言用正则 `//`，配合 `assert.rejects(..., /regex/s)`；若 fake 的连接释放顺序有出入，按实际日志调整正则范围（保留 ROLLBACK/END 断言即可）。

- [ ] **Step 2: 运行测试确认通过**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/backend && PATH="/usr/local/bin:$PATH" node --test steps/sql.test.js`
Expected: 全部 PASS。

- [ ] **Step 3: Commit**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline && git add backend/steps/sql.test.js && git commit -m "test(sql): 事务/回滚/输出绑定/extra 合并/超时用例"
```

---

## Task 6: 测试连接 handler `testCredentialConnection`

**Files:**
- Modify: `backend/handlers/api.js:9`（import `buildDbConfig`/`createConnection`，在凭证区新增导出的 handler）

- [ ] **Step 1: 顶部 import 增加 db providers**

在 `backend/handlers/api.js` 的 import 区追加：

```js
import { buildDbConfig, createConnection } from "../providers/db.js";
```

- [ ] **Step 2: 新增导出 handler（放在 deleteCredential 之后）**

```js
// 测试数据库连接：用草稿 secret（含额外参数）建连并跑 SELECT 1，成功能返回耗时；
// 失败抛可读错误（DISPATCH 捕获后降级为 200 + {ok:false,message}，参照 eciProbeNetworks）。
export async function testCredentialConnection({ kind, secret }) {
  if (kind !== "mysql" && kind !== "pg") {
    throw new HttpError(400, "BAD_DB_KIND", `不支持的数据库类型：${kind || "未填写"}`);
  }
  const cfg = buildDbConfig(kind, secret);
  // 测试连接限时：兜底防不可达主机挂住表单请求（与用户可配超时无关，属安全网）
  if (cfg.connectTimeout == null) cfg.connectTimeout = 5000;
  const start = Date.now();
  const conn = await createConnection(kind, cfg);
  try {
    await conn.query("SELECT 1");
    return { ok: true, latencyMs: Date.now() - start };
  } finally {
    try { await conn.end(); } catch { /* 忽略 */ }
  }
}
```

注意：`buildDbConfig` 里 `ssl` 等 extra 已合并进 `cfg`；test 传入的 `secret` 含 `host/port/user/password/database/extra`。

- [ ] **Step 3: Commit**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline && git add backend/handlers/api.js && git commit -m "feat(api): 新增 testCredentialConnection 测试连接处理器"
```

---

## Task 7: `backend/index.js` 注册 `sql` 步骤与 `/api/credentials/test` 端点

**Files:**
- Modify: `backend/index.js`（RE 正则 / routeToHandler / DISPATCH / steps map，四处）

- [ ] **Step 1: 顶部新增 import**

在既有的 providers/steps import 区追加：

```js
import { makeSqlStep } from "./steps/sql.js";
import { createConnection as createDbConnection } from "./providers/db.js";
```

- [ ] **Step 2: RE 新增匹配**

在 `RE` 对象里、`credentialOne` 之后加：

```js
  credentialTest: /^\/api\/credentials\/test$/,
```

- [ ] **Step 3: routeToHandler 新增分支**

在 `routeToHandler` 里、`if (RE.credentialOne.test(path)) {...}` 之前加：

```js
  if (RE.credentialTest.test(path)) {
    if (m === "POST") return { handler: "api.testCredentialConnection" };
  }
```

- [ ] **Step 4: steps map 注册 sql 类型**

在 `const steps = { shell: ..., approval: ... }` 对象里加：

```js
    sql: makeSqlStep({ getCredentialKind, getCredentialSecrets, createConnection: createDbConnection }),
```

（`getCredentialKind` 与 `getCredentialSecrets` 在 buildApp 内已定义，直接引用。）

- [ ] **Step 5: DISPATCH map 新增登记**

在 DISPATCH 中、`"api.getCredential": ...` 附近加：

```js
  "api.testCredentialConnection": async ({ body }) => {
    try {
      const out = await api.testCredentialConnection(body);
      return ok(out);
    } catch (err) {
      return { status: 200, body: { ok: false, message: err?.message ?? String(err) } };
    }
  },
```

- [ ] **Step 6: 跑后端全量测试确认三处注册与既有用例**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/backend && PATH="/usr/local/bin:$PATH" node --test test/ steps/`
Expected: 全部 PASS（测试连接端点需在 Task 8 补路由断言）。

- [ ] **Step 7: Commit**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline && git add backend/index.js && git commit -m "feat(sql): 注册 sql 步骤与 credentials/test 端点"
```

---

## Task 8: 路由双注册断言补 `credentials/test`

**Files:**
- Modify: `backend/test/webhook.test.js:386`（`routes` 数组）

- [ ] **Step 1: 增加路由用例**

在 `webhook.test.js` 的 `R3 路由双注册` 测试的 `routes` 数组中补一行：

```js
    ["/api/credentials/test", "POST"],
```

- [ ] **Step 2: 运行 webhook 测试**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/backend && PATH="/usr/local/bin:$PATH" node --test test/webhook.test.js`
Expected: PASS（`routeToHandler` 命中 `api.testCredentialConnection` 且 `isDispatched` 为真）。

- [ ] **Step 3: Commit**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline && git add backend/test/webhook.test.js && git commit -m "test(api): 断言 /api/credentials/test 双注册"
```

---

## Task 9: 运行后端全量测试（里程碑）

- [ ] **Step 1: 全量测试**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/backend && PATH="/usr/local/bin:$PATH" node --test`
Expected: 全部 PASS（新增 sql/engine 用例 + 既有全部用例）。

- [ ] **Step 2: 冒烟验证建连代理（不连真实库，仅确认 import/形状）**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/backend && PATH="/usr/local/bin:$PATH" node -e "import('./providers/db.js').then(m => console.log(Object.keys(m)))"`
Expected: 输出 `[ coerceExtraValue, buildDbConfig, createConnection ]`（无抛错）。

---

## Task 10: 前端 `kinds.js` 增加 mysql / pg 凭证类型

**Files:**
- Modify: `frontend/src/lib/kinds.js`（`CRED_KINDS` 数组，追加两项）

- [ ] **Step 1: 在 CRED_KINDS 末尾追加 mysql 与 pg**

在 `CRED_KINDS` 数组末尾（`s3` 项之后）追加：

```js
  {
    value: "mysql",
    label: "MySQL 数据库",
    icon: "M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
    hint: "数据库连接凭证（SQL 节点后端直连执行）。固定字段见下；其余驱动连接参数（ssl / charset / connectTimeout 等）在「额外连接参数」按需添加，可多条。",
    fields: [
      { k: "host", label: "主机 Host", ph: "db.example.com", required: true },
      { k: "port", label: "端口 Port", ph: "3306" },
      { k: "user", label: "用户名", ph: "user", required: true },
      { k: "password", label: "密码", ph: "password", secret: true, required: true },
      { k: "database", label: "数据库名", ph: "mydb", required: true },
      { k: "extra", label: "额外连接参数", type: "kvlist", hint: "键=值，可添加多条；如 ssl=true / charset=utf8mb4 / connectTimeout=10000" },
    ],
  },
  {
    value: "pg",
    label: "PostgreSQL 数据库",
    icon: "M12 3v18M12 9l-6-3M12 9l6-3M12 15l-6 3M12 15l6 3M4 20c4 2 12 2 16 0",
    hint: "数据库连接凭证（SQL 节点后端直连执行）。固定字段见下；其余驱动连接参数（ssl / application_name / statement_timeout 等）在「额外连接参数」按需添加，可多条。",
    fields: [
      { k: "host", label: "主机 Host", ph: "db.example.com", required: true },
      { k: "port", label: "端口 Port", ph: "5432" },
      { k: "user", label: "用户名", ph: "postgres", required: true },
      { k: "password", label: "密码", ph: "password", secret: true, required: true },
      { k: "database", label: "数据库名", ph: "mydb", required: true },
      { k: "extra", label: "额外连接参数", type: "kvlist", hint: "键=值，可添加多条；如 ssl=true / charset & application_name 等" },
    ],
  },
```

说明：`type:'kvlist'` 是该 kind 新增的字段形态（Task 11 让表单支持渲染），单测/构建不依赖别的逻辑。

- [ ] **Step 2: 前端构建验证**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: build 成功。

- [ ] **Step 3: Commit**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline && git add frontend/src/lib/kinds.js && git commit -m "feat(cred): 凭证类型新增 mysql / pg（含额外参数 kvlist 字段）"
```

---

## Task 11: 前端 `api/credential.js` 与 `CredentialForm.vue`（kvlist + 测试连接）

**Files:**
- Modify: `frontend/src/api/credential.js`
- Modify: `frontend/src/pages/CredentialForm.vue`

- [ ] **Step 1: credential.js 新增 testCredentialConnection**

在 `frontend/src/api/credential.js` 追加：

```js
// 用草稿 secret 测试数据库连接连通性（不落库）；参照 eci 探测接口的降级返回
export const testDbConnection = (d) => client.post("/credentials/test", d, { silent: true, timeout: 8000 });
```

- [ ] **Step 2: CredentialForm.vue 支持 kvlist 渲染 + 测试连接按钮**

在 `<script setup>` 中 import 测试函数并在 `form` 初始化/切类型时补 `extra`：

```js
import { testDbConnection } from "../api/credential.js";
const testing = ref(false);
const testResult = ref(null); // { ok, latencyMs } 或 { message }
const isDbKind = computed(() => form.value.kind === "mysql" || form.value.kind === "pg");
const isKvlist = (f) => f.type === "kvlist";
```

在 `<template>` 的字段循环处（`v-for="f in kindFields"` 内、普通 input 渲染处）改为：普通字段走 input；`type==='kvlist'` 走动态列表：

```html
<template v-for="f in kindFields" :key="f.k">
  <div v-if="isKvlist(f)" class="field">
    <label class="field-label">{{ f.label }}</label>
    <div v-for="(row, i) in (form.secret.extra || [])" :key="i" class="kv-row">
      <input class="input mono" v-model="row.key" placeholder="键（如 ssl）" />
      <input class="input mono" v-model="row.value" placeholder="值（如 true）" />
      <button type="button" class="btn btn-sm btn-danger" @click="form.secret.extra.splice(i, 1)">删</button>
    </div>
    <div class="kv-actions">
      <button type="button" class="btn btn-sm btn-ghost" @click="(form.secret.extra || (form.secret.extra = [])).push({ key: '', value: '' })">＋添加一条</button>
    </div>
    <p v-if="f.hint" class="field-hint">{{ f.hint }}</p>
    <p v-if="kvDupError" class="field-hint warn">额外参数键不能重复：{{ kvDupError }}</p>
  </div>
  <div v-else class="field">
    <label class="field-label">{{ f.label }}<span v-if="f.required" class="req">*</span></label>
    <input class="input" :type="f.secret ? 'password' : 'text'" v-model="form.secret[f.k]" :placeholder="isNew ? f.ph : (f.secret ? '留空则保持不变（仅展示一次）' : f.ph)" />
    <p v-if="f.hint" class="field-hint">{{ f.hint }}</p>
  </div>
</template>
```

在表单底部、保存按钮前加「测试连接」按钮（仅数据库凭证显示）与结果提示：

```html
<section v-if="isDbKind" class="field test-conn">
  <button type="button" class="btn btn-sm btn-ghost" :disabled="testing" @click="doTestConn">⟳ 测试连接</button>
  <template v-if="testResult">
    <p v-if="testResult.ok" class="field-hint ok">连接成功，耗时 {{ testResult.latencyMs }}ms</p>
    <p v-else class="field-hint warn">连接失败：{{ testResult.message }}</p>
  </template>
</section>
```

`script setup` 内追加逻辑（含键去重校验）：

```js
const kvDupError = computed(() => {
  const arr = form.value.secret?.extra || [];
  const seen = new Set(); const dup = [];
  for (const r of arr) { if (r?.key && seen.has(r.key)) dup.push(r.key); seen.add(r.key); }
  return dup.length ? dup.join("、") : "";
});
async function doTestConn() {
  testing.value = true; testResult.value = null;
  try {
    testResult.value = await testDbConnection({ kind: form.value.kind, secret: form.value.secret });
  } catch (e) { testResult.value = { message: e?.message || "连接测试失败" }; }
  finally { testing.value = false; }
}
```

补少量样式（`<style scoped>`）：

```css
.kv-row { display: flex; gap: 8px; margin-bottom: 8px; }
.kv-row .input { flex: 1; }
.kv-actions { margin: 2px 0 10px; }
.test-conn { margin-top: 2px; }
.field-hint.ok { color: var(--accent); }
```

注意：保存逻辑无需改（后端 `createCredential` 对 mysql/pg 走通用 SM4 落库；`extra` 随 secret JSON 一并加密）。

- [ ] **Step 3: 前端构建验证**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: build 成功。

- [ ] **Step 4: Commit**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline && git add frontend/src/api/credential.js frontend/src/pages/CredentialForm.vue && git commit -m "feat(cred): 凭证表单支持额外参数列表与测试连接"
```

---

## Task 12: 前端 `PipelineEdit.vue`（SQL 节点编辑区）

**Files:**
- Modify: `frontend/src/pages/PipelineEdit.vue`

- [ ] **Step 1: import 补 testDbConnection 与 DB 凭证过滤**

在 import 区（`../api/credential.js` 那行）追加：

```js
import { ... /* 既有 fetchCredentials 等 */ , testDbConnection } from "../api/credential.js";
```

在 `eciCreds`/`robotCreds` 附近追加：

```js
const SQL_CRED_KINDS = ["mysql", "pg"];
const sqlCreds = computed(() => (creds.value || []).filter((c) => SQL_CRED_KINDS.includes(c.kind)));
const sqlTesting = ref("");
const sqlTestResult = ref({});
async function doSqlTest(n) {
  const name = n.params?.credential; if (!name) return;
  const c = creds.value.find((x) => x.name === name); if (!c) return;
  sqlTesting.value = name; sqlTestResult.value[name] = null;
  try { sqlTestResult.value[name] = await testDbConnection({ kind: c.kind, secret: c.secret_for_test ?? {} }); }
  catch (e) { sqlTestResult.value[name] = { message: e?.message || "测试失败" }; }
  finally { sqlTesting.value = ""; }
}
```

> 说明：节点上引用的是已保存凭证，前端拿不到其 `secret`（后端不返显）。因此 SQL 节点编辑区**不提供**节点级「测试连接」；连通性在凭证表单用草稿 secret 测试。保存后再需要验证可到凭证页测试。若实现时节点需展示已有凭证不可直接测，此按钮可省略，仅保留凭证下拉。

- [ ] **Step 2: `NODE_KINDS` 增加 sql + `addNode` 分支**

`NODE_KINDS` 对象追加：

```js
  sql: { label: "SQL 执行", accent: "var(--accent)", icon: "M4 5h16M7 3l2 2-2 2M12 3l2 2-2 2M7 12H4v3h3zM4 21h7M6 15v6M15 8l5 5M15 13h2a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2h-2" },
```

`addNode(type)` 里，把 `if (type === "shell" || type === "approval") loadCreds();` 改为：

```js
  if (type === "shell" || type === "approval" || type === "sql") loadCreds();
```

并在 `addNode` 的 params 三元表达式里加 sql 分支（在 `type === "shell"` 条件分支之外追加后置判断）：

```js
  const node = {
    id: `n${Date.now()}`,
    type,
    step: type,
    params:
        type === "shell"
          ? { image: images.value[0]?.image ?? "alpine", command: "", env: [], outputs: [{ key: "step_out" }], credential: "", regionId: "", vswitchId: "", securityGroupId: "", cpu: "1", memory: "2", timeout: 300 }
          : type === "sql"
            ? { credential: "", statements: [""], outputs: [{ key: "affected_rows" }], timeout: 60 }
            : { robot: "", message: DEFAULT_APPROVAL_BODY, target: { type: "user", openIds: "", members: [] } },
    name: "",
  };
```

- [ ] **Step 3: 节点列表「添加节点」按钮区加 SQL**

在 template 顶部添加节点按钮组（shell/approval 按钮旁）加一个：

```html
<button class="btn node-add sql" @click="addNode('sql')">＋ SQL 执行</button>
```

- [ ] **Step 4: 节点编辑区加 sql 分支模板**

在 `<div class="node-body">` 内、`<template v-if="n.type === 'shell'">...</template>` 之后加：

```html
<template v-else-if="n.type === 'sql'">
  <div class="field">
    <label class="field-label">数据库凭证 <span class="req">*</span></label>
    <select class="select" v-model="n.params.credential">
      <option value="">选择数据库连接凭证…</option>
      <option v-for="c in sqlCreds" :key="c.name" :value="c.name">{{ c.name }}</option>
    </select>
    <p class="field-hint" v-if="!sqlCreds.length">暂无数据库凭证，请先在「凭证」中创建 MySQL 或 PostgreSQL 类型凭证</p>
    <p class="field-hint" v-else>凭证提供连接信息；TLS/字符集等额外参数在凭证里配置</p>
  </div>
  <div class="field">
    <label class="field-label">SQL 语句（在一个事务内逐条执行）<span class="req">*</span></label>
    <div v-for="(stmt, i) in n.params.statements" :key="i" class="sql-stmt-row">
      <textarea class="textarea mono" v-model="n.params.statements[i]" rows="3" placeholder="支持 ${变量}，引用前驱节点输出或触发参数"></textarea>
      <button type="button" class="btn btn-sm btn-danger" @click="n.params.statements.splice(i, 1)">删</button>
    </div>
    <div class="sql-actions">
      <button type="button" class="btn btn-sm btn-ghost" @click="n.params.statements.push('')">＋添加一条语句</button>
    </div>
  </div>
  <div class="field">
    <label class="field-label">输出变量</label>
    <div v-for="(o, i) in n.params.outputs" :key="i" class="sql-out-row">
      <input class="input mono" v-model="o.key" placeholder="变量 key" />
      <input class="input mono" v-model="o.column" placeholder="列名（可选，绑最后结果集首行）" />
      <button type="button" class="btn btn-sm btn-danger" @click="n.params.outputs.splice(i, 1)">删</button>
    </div>
    <div class="sql-actions">
      <button type="button" class="btn btn-sm btn-ghost" @click="n.params.outputs.push({ key: '', column: '' })">＋添加输出</button>
    </div>
    <p class="field-hint">填写列名时按该列取值；不填列名则输出最后一条语句的影响/返回行数</p>
  </div>
  <div class="field">
    <label class="field-label">超时（秒，可选）</label>
    <input class="input mono" type="number" v-model="n.params.timeout" placeholder="如 60" />
    <p class="field-hint">后端直连执行；超出视为失败并回滚，防止长 SQL 阻塞请求</p>
  </div>
</template>
```

- [ ] **Step 5: 前端构建验证**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: build 成功。

> 注意：SQL 文本写在普通模板字符串/`v-model` 里，**切勿把 `${变量}` 写进 JS 反引号模板字符串**（AGENTS.md 强调的整页白屏事故）；在 `<textarea>` 内写 `${...}` 由 Vue 文本插值渲染，安全。

- [ ] **Step 6: Commit**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline && git add frontend/src/pages/PipelineEdit.vue && git commit -m "feat(frontend): SQL 节点编辑区（凭证/语句列表/输出/超时）"
```

---

## Task 13: 前端 `ExecutionDetail.vue`（sql 节点详情分支）

**Files:**
- Modify: `frontend/src/pages/ExecutionDetail.vue`

- [ ] **Step 1: `effType` 识别 sql**

把现有的 `effType` 箭头函数改为：

```js
const effType = (s) => {
  if (s.type || s.stepType) return s.type || s.stepType;
  return s.params ? (Array.isArray(s.params.statements) ? "sql" : s.params.command ? "shell" : (s.params.message || s.params.robot) ? "approval" : "") : "";
};
```

- [ ] **Step 2: `stepSub` 增加 sql 描述**

在 `stepSub` 里、`else if (t === "approval")` 之前加：

```js
  else if (t === "sql") {
    if (p?.credential) parts.push(`库 ${p.credential}`);
    if (Array.isArray(p?.statements)) parts.push(`${p.statements.length} 条语句`);
    if (!parts.length) parts.push("SQL 操作");
  }
```

- [ ] **Step 3: 详情模板加 sql 分支**

在 Shell 分支 template 之后加：

```html
<!-- SQL：连接凭证 + 语句 + 日志 + 输出 -->
<template v-else-if="effType(s) === 'sql'">
  <span class="stsub mono">SQL 配置</span>
  <div class="cfg-grid">
    <span class="cfg-item"><span class="cfg-k">凭证</span><span class="cfg-v mono">{{ s.params?.credential || "—" }}</span></span>
    <span class="cfg-item cfg-wide"><span class="cfg-k">语句</span>
      <span class="cfg-v mono">{{ Array.isArray(s.params?.statements) ? s.params.statements.map((x, i) => `${i + 1}. ${x}`).join("\n") : "（无）" }}</span>
    </span>
    <span class="cfg-item"><span class="cfg-k">超时</span><span class="cfg-v mono">{{ s.params?.timeout ? `${s.params.timeout}s` : "—" }}</span></span>
  </div>
  <template v-if="s.logs">
    <span class="stsub mono">执行日志</span>
    <pre class="log-pre mono">{{ s.logs }}</pre>
  </template>
</template>
```

（`s.logs` 由 Task 4 的 `record({...logs})` 写入；`hasOutput(s)` 通用块已展示输出 KV。）

- [ ] **Step 4: 前端构建验证**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: build 成功。

- [ ] **Step 5: Commit**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline && git add frontend/src/pages/ExecutionDetail.vue && git commit -m "feat(frontend): 执行详情展示 SQL 节点配置/日志/输出"
```

---

## Task 14: 前端全量构建 + 全量回归（交付前）

- [ ] **Step 1: 前端构建**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: 成功。

- [ ] **Step 2: 后端全量测试**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/backend && PATH="/usr/local/bin:$PATH" node --test`
Expected: 全部 PASS。

- [ ] **Step 3: 若存在 `docs/...` 规格变更一并提交并收尾**

确认无遗留未提交改动后，optional：打 `v0.1.0-rcNN` pre-release tag 触发发布构建（见 AGENTS.md）。是否打 tag 由用户决定，不擅自操作。

---

## Self-Review 对照（规格 → 任务）

- 凭证 mysql/pg 两个 kind：Task 10 前端 kinds.js；后端 kind 校验 Task 3，通用落库无需改（既有 `createCredential`）。
- 固定字段 + `extra` 自定义多条、ssl 不自带：Task 2 `buildDbConfig`；Task 10/11 表单 `kvlist`。
- 测试连接端点：Task 6 handler、Task 7 三处注册（RE/routeToHandler/DISPATCH）、Task 8 路由断言、Task 11 前端按钮。
- SQL 节点 params（statements 显式列表 / outputs / timeout）：Task 3 step、Task 12 前端。
- 单事务逐条执行、失败回滚 + 回显已成功语句 + 定位失败序号：Task 3 + 测试 Task 5。
- 输出绑定（column / 无 column 行数）：Task 3 `buildOutput` + Task 5。
- `${var}` 变量渲染 + 作用域校验：由既有 `renderParams`/`collectNodeDeps` 天然支持（statements 数组被遍历、outputs 被跳过），Task 5 验证。
- 超时兜底：Task 3 `withTimeout`/`coerceTimeout` + Task 5。
- 错误可读 + 不泄露凭据：Task 3 `readableError`、Task 6 返回 message；SM4 加密 `extra`：既有安全性，Task 1/10 相应说明。
- 执行详情展示：Task 4（logs 入库）+ Task 13（前端 sql 分支）。
- 依赖：Task 1 `mysql2`。

无遗留占位符；所有代码步骤给出完整可执行体。