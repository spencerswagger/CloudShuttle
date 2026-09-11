import test from "node:test";
import assert from "node:assert/strict";
import { validateSpec } from "./dag.js";

function node(id) { return { id, type: "sql" }; }

test("validateSpec 通过合法 DAG（无环、边端点存在、id 唯一）", () => {
  const out = validateSpec({ nodes: [node("a"), node("b")], edges: [{ from: "a", to: "b" }] });
  assert.deepEqual(out, { ok: true, errors: [] });
});

test("validateSpec 检出重 id", () => {
  const out = validateSpec({ nodes: [node("a"), node("a")], edges: [] });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /重复|duplicate|id/i.test(e)));
});

test("validateSpec 检出边端点不存在", () => {
  const out = validateSpec({ nodes: [node("a")], edges: [{ from: "a", to: "ghost" }] });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /ghost/.test(e)));
});

test("validateSpec 检出环（a→b→a）", () => {
  const out = validateSpec({ nodes: [node("a"), node("b")], edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /环|cycle/i.test(e)));
});