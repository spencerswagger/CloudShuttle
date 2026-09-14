import test from "node:test";
import assert from "node:assert/strict";
import { validateSpec, loopRegionOf } from "./dag.js";

function node(id, type = "sql") { return { id, type }; }

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

test("validateSpec 校验边条件格式（path 缺失 / op 非法）", () => {
  const bad1 = validateSpec({ nodes: [node("a"), node("b")], edges: [{ from: "a", to: "b", cond: { path: "", op: "eq", val: "x" } }] });
  assert.ok(bad1.errors.some((e) => e.includes("条件缺少 path")));
  const bad2 = validateSpec({ nodes: [node("a"), node("b")], edges: [{ from: "a", to: "b", cond: { path: "$.x", op: "like", val: "x" } }] });
  assert.ok(bad2.errors.some((e) => e.includes("op 非法")));
  // 合法条件与无条件边：不产生条件类错误，整体 ok
  const good = validateSpec({
    nodes: [node("a"), node("b"), node("c")],
    edges: [{ from: "a", to: "b", cond: { path: "$.x", op: "eq", val: "y" } }, { from: "b", to: "c" }],
  });
  assert.equal(good.ok, true);
});

test("loopRegionOf 正常区域：body 含普通节点，返回 bodyIds 与 joinId", () => {
  const nodes = [node("l", "loop"), node("s", "shell"), node("j", "join")];
  const edges = [{ from: "l", to: "s" }, { from: "s", to: "j" }];
  const out = loopRegionOf({ nodes, edges, loopId: "l" });
  assert.deepEqual(out.bodyIds, ["s"]);
  assert.equal(out.joinId, "j");
  assert.equal(out.err, undefined);
});

test("loopRegionOf 拒绝：循环体内嵌套控制节点", () => {
  const nodes = [node("l", "loop"), node("b", "branch"), node("j", "join")];
  const edges = [{ from: "l", to: "b" }, { from: "b", to: "j" }];
  const out = loopRegionOf({ nodes, edges, loopId: "l" });
  assert.ok(out.err.includes("不允许 branch"));
});

test("loopRegionOf 拒绝：loop 出边直连 join（循环体为空）", () => {
  const nodes = [node("l", "loop"), node("j", "join")];
  const edges = [{ from: "l", to: "j" }];
  const out = loopRegionOf({ nodes, edges, loopId: "l" });
  assert.ok(out.err.includes("循环体至少 1 个节点"));
});

test("loopRegionOf 拒绝：缺少 join / join 入边来自区域外", () => {
  const noJoin = loopRegionOf({ nodes: [node("l", "loop"), node("s", "shell")], edges: [{ from: "l", to: "s" }], loopId: "l" });
  assert.ok(noJoin.err.includes("缺少收敛的 join"));
  const nodes = [node("l", "loop"), node("s", "shell"), node("j", "join"), node("x", "shell")];
  const edges = [{ from: "l", to: "s" }, { from: "s", to: "j" }, { from: "x", to: "j" }];
  const out = loopRegionOf({ nodes, edges, loopId: "l" });
  assert.ok(out.err.includes("循环体外节点 x"));
});

test("validateSpec 校验 loop 区域约束（体内嵌套 / 缺 join）", () => {
  const nodes = [node("l", "loop"), node("b", "branch"), node("j", "join")];
  const edges = [{ from: "l", to: "b" }, { from: "b", to: "j" }];
  const out = validateSpec({ nodes, edges });
  assert.ok(out.errors.some((e) => e.includes("循环体内不允许 branch")));
});
