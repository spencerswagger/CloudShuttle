// backend/engine/trigger.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { extractWebhookVars, extractManualVars } from "./trigger.js";

test("webhook JSONPath 从 body 多路径取多个变量（含嵌套）", () => {
  const body = {
    ref: "refs/heads/main",
    head_commit: {
      author: { name: "Alice", email: "alice@x.io" },
      message: "feat: hi",
    },
    pusher: { name: "Bob" },
  };
  const env = new Map();
  extractWebhookVars(
    [
      { name: "branch", jsonPath: "$.ref" },
      { name: "author", jsonPath: "$.head_commit.author.name" },
      { name: "commit_msg", jsonPath: "$.head_commit.message" },
    ],
    body,
    env,
  );
  assert.deepEqual(Object.fromEntries(env), {
    branch: "refs/heads/main",
    author: "Alice",
    commit_msg: "feat: hi",
  });
});

test("webhook 嵌套不存在的路径不写入、不抛错", () => {
  const env = new Map();
  assert.doesNotThrow(() =>
    extractWebhookVars(
      [{ name: "missing", jsonPath: "$.no.such.path" }],
      { ref: "main" },
      env,
    ),
  );
  assert.equal(env.size, 0);
});

test("webhook 异常 json（body 为空串/非对象/undefined）不写入、不抛错", () => {
  const env = new Map();
  assert.doesNotThrow(() =>
    extractWebhookVars([{ name: "x", jsonPath: "$.ref" }], "", env),
  );
  assert.doesNotThrow(() =>
    extractWebhookVars([{ name: "x", jsonPath: "$.ref" }], undefined, env),
  );
  assert.doesNotThrow(() =>
    extractWebhookVars([{ name: "x", jsonPath: "$.ref" }], "not json", env),
  );
  assert.equal(env.size, 0);
});

test("webhook 路径命中数组时取首元素", () => {
  const env = new Map();
  extractWebhookVars(
    [{ name: "first_file", jsonPath: "$.files[*].filename" }],
    { files: [{ filename: "a.js" }, { filename: "b.js" }] },
    env,
  );
  assert.equal(env.get("first_file"), "a.js");
});

test("webhook null 值视为无值，不写入", () => {
  const env = new Map();
  extractWebhookVars(
    [{ name: "n", jsonPath: "$.nullable" }],
    { nullable: null },
    env,
  );
  assert.equal(env.size, 0);
});

test("manual 从 formValue 取 key", () => {
  const env = new Map();
  extractManualVars(
    [
      { key: "name", default: "D" },
      { key: "env", default: "prod" },
    ],
    { name: "ship", env: "test" },
    env,
  );
  assert.deepEqual(Object.fromEntries(env), { name: "ship", env: "test" });
});

test("manual 缺失 key 用 default 填补", () => {
  const env = new Map();
  extractManualVars(
    [
      { key: "a", default: "A" },
      { key: "b", default: "B" },
    ],
    { a: "" },
    env,
  );
  assert.deepEqual(Object.fromEntries(env), { a: "A", b: "B" });
});

test("manual formValue 有效值覆盖 default", () => {
  const env = new Map();
  extractManualVars([{ key: "x", default: "D" }], { x: "real" }, env);
  assert.equal(env.get("x"), "real");
});

test("manual 空/未命中的 key 不写（无 default）", () => {
  const env = new Map();
  extractManualVars(
    [
      { key: "no_default", default: null },
      { key: "undef", default: undefined },
    ],
    { no_default: "", other: "hi" },
    env,
  );
  assert.equal(env.size, 0);
});