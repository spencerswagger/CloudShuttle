// backend/handlers/api.test.js —— buildTestConfig 纯函数 + 测试连接 handler 行为
// 覆盖：5s 限时安全网按 kind 生效、用户显式超时保留、非法值不绕过安全网。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestConfig } from "./api.js";

const SECRET = { host: "127.0.0.1", port: 3306, user: "u", password: "p", database: "d" };

test("pg 未配置超时 → connectionTimeoutMillis 兜底 5000（能抓到旧实现 10000）", () => {
  const cfg = buildTestConfig("pg", SECRET);
  assert.equal(cfg.connectionTimeoutMillis, 5000);
});

test("mysql 未配置超时 → connectTimeout 兜底 5000", () => {
  const cfg = buildTestConfig("mysql", SECRET);
  assert.equal(cfg.connectTimeout, 5000);
});

test("pg 顶层显式 connectionTimeoutMillis: 30000 → 保留 30000", () => {
  const cfg = buildTestConfig("pg", { ...SECRET, connectionTimeoutMillis: 30000 });
  assert.equal(cfg.connectionTimeoutMillis, 30000);
});

test("mysql 经 extra 配置 connectTimeout 30000 → 保留 30000", () => {
  const cfg = buildTestConfig("mysql", {
    ...SECRET,
    extra: [{ key: "connectTimeout", value: 30000 }],
  });
  assert.equal(cfg.connectTimeout, 30000);
});

test("pg 经 extra 配置 connectionTimeoutMillis '30000'（字符串）→ 保留 30000", () => {
  const cfg = buildTestConfig("pg", {
    ...SECRET,
    extra: [{ key: "connectionTimeoutMillis", value: "30000" }],
  });
  assert.equal(cfg.connectionTimeoutMillis, 30000);
});

test("mysql 顶层非法值 'abc' → 兜底 5000（能抓到 NaN 绕过）", () => {
  const cfg = buildTestConfig("mysql", { ...SECRET, connectTimeout: "abc" });
  assert.equal(cfg.connectTimeout, 5000);
});

test("pg 顶层非法值 'abc' → 兜底 5000（而非 buildDbConfig 的 10000 默认）", () => {
  const cfg = buildTestConfig("pg", { ...SECRET, connectionTimeoutMillis: "abc" });
  assert.equal(cfg.connectionTimeoutMillis, 5000);
});

test("mysql extra 配置非法 connectTimeout 'abc' → 兜底 5000", () => {
  const cfg = buildTestConfig("mysql", {
    ...SECRET,
    extra: [{ key: "connectTimeout", value: "abc" }],
  });
  assert.equal(cfg.connectTimeout, 5000);
});

test("mysql 顶层空串 connectTimeout '' → 兜底 5000（空串不得视为显式 0）", () => {
  const cfg = buildTestConfig("mysql", { ...SECRET, connectTimeout: "" });
  assert.equal(cfg.connectTimeout, 5000);
});

test("pg 顶层空白串 connectionTimeoutMillis '  ' → 兜底 5000（不得覆盖默认 10000 成 0）", () => {
  const cfg = buildTestConfig("pg", { ...SECRET, connectionTimeoutMillis: "  " });
  assert.equal(cfg.connectionTimeoutMillis, 5000);
});

test("buildTestConfig 不校验 kind（纯配置函数），非 mysql/pg 仅按非 pg 键名兜底", () => {
  const cfg = buildTestConfig("oracle", SECRET);
  assert.equal(cfg.connectTimeout, 5000);
});

test("非 mysql/pg 的 kind 由 handler 抛 400，不发起连接", async () => {
  const { testCredentialConnection } = await import("./api.js");
  await assert.rejects(
    testCredentialConnection({ kind: "oracle", secret: SECRET }),
    (e) => e.status === 400 && e.code === "BAD_DB_KIND"
  );
});

test("steps 类型注册表包含 sql（buildApp 装配来源，启动时校验一致）", async () => {
  const { STEP_TYPES } = await import("../index.js");
  assert.ok(STEP_TYPES.includes("sql"));
});
