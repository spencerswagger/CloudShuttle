// backend/engine/trigger.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { extractWebhookVars, extractManualVars, assembleTriggerEnv } from "./trigger.js";

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

// ---------- assembleTriggerEnv：触发源「spec.trigger 配置 → environment Map」装配 ----------

test("assembleTriggerEnv：manual 表单值叠写到 initEnv 之上", () => {
  const env = assembleTriggerEnv({
    spec: { trigger: { manual: { params: [{ key: "name", default: "D" }] } }, nodes: [], edges: [] },
    formValue: { name: "ship" },
    initEnv: new Map([["pipeline_id", "1"], ["pipeline_name", "p"]]),
  });
  // 元信息保留，manual 有效值写入；无值/缺省不覆盖元信息
  assert.deepEqual(Object.fromEntries(env), { pipeline_id: "1", pipeline_name: "p", name: "ship" });
});

test("assembleTriggerEnv：manual 缺失 key 用 default，多余 initEnv key 保留", () => {
  const env = assembleTriggerEnv({
    spec: { trigger: { manual: { params: [{ key: "a", default: "A" }, { key: "b", default: null }] } } },
    formValue: {},
    initEnv: new Map([["run_no", "7"]]),
  });
  assert.deepEqual(Object.fromEntries(env), { run_no: "7", a: "A" });
});

test("assembleTriggerEnv：webhook mappings 从 body 抽取并保留元信息", () => {
  const env = assembleTriggerEnv({
    spec: { trigger: { webhook: { mappings: [{ name: "branch", jsonPath: "$.ref" }] } } },
    webhookBody: { ref: "refs/heads/main" },
    initEnv: new Map([["exec_id", "9"]]),
  });
  assert.deepEqual(Object.fromEntries(env), { exec_id: "9", branch: "refs/heads/main" });
});

test("assembleTriggerEnv：manual 与 webhook 同时配置时各自抽取并存", () => {
  const env = assembleTriggerEnv({
    spec: {
      trigger: {
        manual: { params: [{ key: "env", default: "prod" }] },
        webhook: { mappings: [{ name: "branch", jsonPath: "$.ref" }] },
      },
    },
    formValue: { env: "staging" },
    webhookBody: { ref: "main" },
    initEnv: new Map(),
  });
  assert.deepEqual(Object.fromEntries(env), { env: "staging", branch: "main" });
});

test("assembleTriggerEnv：无 trigger 配置时仅返回 initEnv，且不抛错", () => {
  const env = assembleTriggerEnv({ spec: { nodes: [] }, initEnv: new Map([["exec_id", "3"]]) });
  assert.deepEqual(Object.fromEntries(env), { exec_id: "3" });
});

// ---------- 统一触发参数：manual 与 webhook 共用 spec.trigger.params（webhook 多 jsonPath） ----------

test("统一 params：webhook 按 jsonPath 抽取，未命中回退 default", () => {
  const env = assembleTriggerEnv({
    spec: {
      trigger: {
        params: [
          { key: "branch", default: "main", jsonPath: "$.ref" },
          { key: "env", default: "prod" }, // 无 jsonPath：webhook 触发也用 default
        ],
      },
    },
    webhookBody: { ref: "refs/heads/dev" },
    initEnv: new Map(),
  });
  assert.deepEqual(Object.fromEntries(env), { branch: "refs/heads/dev", env: "prod" });
});

test("统一 params：manual 表单值覆盖 default，jsonPath 字段被忽略", () => {
  const env = assembleTriggerEnv({
    spec: { trigger: { params: [{ key: "branch", default: "main", jsonPath: "$.ref" }] } },
    formValue: { branch: "feat-x" },
    initEnv: new Map(),
  });
  assert.equal(env.get("branch"), "feat-x");
});

test("统一 params：webhook 命中为 null 时回退 default，而非写入 null", () => {
  const env = assembleTriggerEnv({
    spec: { trigger: { params: [{ key: "n", default: "d", jsonPath: "$.x" }] } },
    webhookBody: { x: null },
    initEnv: new Map(),
  });
  assert.equal(env.get("n"), "d");
});

test("triggerParamsOf：旧结构（manual.params + webhook.mappings）按 key 合并兜底", () => {
  const env = assembleTriggerEnv({
    spec: {
      trigger: {
        manual: { params: [{ key: "branch", default: "main" }] },
        webhook: { mappings: [{ name: "branch", jsonPath: "$.ref" }, { name: "extra", jsonPath: "$.e" }] },
      },
    },
    webhookBody: { ref: "dev" },
    initEnv: new Map(),
  });
  // branch 双边都有 → 合并为同一参数（jsonPath 叠上）；extra 仅 webhook 有 → 补 key
  assert.deepEqual(Object.fromEntries(env), { branch: "dev" });
});