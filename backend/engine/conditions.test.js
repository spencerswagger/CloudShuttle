import test from "node:test";
import assert from "node:assert/strict";
import { evalCond, buildCondCtx, COND_OPS } from "./conditions.js";

const ctx = buildCondCtx({
  triggerRaw: { branch: "release", count: 3, tags: ["v1", "v2"], note: "" },
  nodeOutputs: { shell1: { sha: "abc123", rows: 5 } },
  env: { pipeline_name: "demo" },
});

test("COND_OPS 白名单齐全", () => {
  assert.deepEqual(COND_OPS, ["eq", "ne", "gt", "ge", "lt", "le", "contains", "starts_with", "ends_with", "exists", "empty", "regex"]);
});

test("eq / ne 对字符串与数字", () => {
  assert.equal(evalCond({ path: "$.trigger.branch", op: "eq", val: "release" }, ctx), true);
  assert.equal(evalCond({ path: "$.trigger.branch", op: "ne", val: "dev" }, ctx), true);
  assert.equal(evalCond({ path: "$.trigger.count", op: "eq", val: 3 }, ctx), true);
});

test("gt / ge / lt / le 数值比较（字符串值也能转数字）", () => {
  assert.equal(evalCond({ path: "$.outputs.shell1.rows", op: "gt", val: 3 }, ctx), true);
  assert.equal(evalCond({ path: "$.trigger.count", op: "ge", val: 3 }, ctx), true);
  assert.equal(evalCond({ path: "$.outputs.shell1.rows", op: "lt", val: 10 }, ctx), true);
  assert.equal(evalCond({ path: "$.trigger.count", op: "le", val: 2 }, ctx), false);
});

test("contains / starts_with / ends_with", () => {
  assert.equal(evalCond({ path: "$.trigger.branch", op: "contains", val: "ease" }, ctx), true);
  assert.equal(evalCond({ path: "$.trigger.branch", op: "starts_with", val: "rel" }, ctx), true);
  assert.equal(evalCond({ path: "$.trigger.branch", op: "ends_with", val: "ase" }, ctx), true);
});

test("exists / empty（数组与非空串）", () => {
  assert.equal(evalCond({ path: "$.trigger.note", op: "exists" }, ctx), true);
  assert.equal(evalCond({ path: "$.trigger.note", op: "empty" }, ctx), true);
  assert.equal(evalCond({ path: "$.trigger.branch", op: "empty" }, ctx), false);
  assert.equal(evalCond({ path: "$.trigger.missing", op: "exists" }, ctx), false);
  assert.equal(evalCond({ path: "$.trigger.missing", op: "empty" }, ctx), true);
});

test("regex 命中与非法正则", () => {
  assert.equal(evalCond({ path: "$.outputs.shell1.sha", op: "regex", val: "^abc" }, ctx), true);
  assert.equal(evalCond({ path: "$.outputs.shell1.sha", op: "regex", val: "(" }, ctx), false);
});

test("JSONPath 命中数组时取首元素（wrap:false 语义对齐 trigger.js）", () => {
  assert.equal(evalCond({ path: "$.trigger.tags", op: "eq", val: "v1" }, ctx), true);
});

test("非法条件（缺 path / op 不在白名单）恒 false", () => {
  assert.equal(evalCond({ path: "", op: "eq", val: "x" }, ctx), false);
  assert.equal(evalCond({ path: "$.trigger.branch", op: "like", val: "x" }, ctx), false);
  assert.equal(evalCond(null, ctx), false);
});

test("JSONPath 异常静默 false（不抛错）", () => {
  assert.equal(evalCond({ path: "$..[", op: "eq", val: "x" }, ctx), false);
});

test("buildCondCtx 缺省字段给 null/空对象，不抛错", () => {
  const c = buildCondCtx({});
  assert.deepEqual(c, { trigger: null, outputs: {}, env: {} });
});
