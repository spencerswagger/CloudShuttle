// backend/test/dag.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, nextReady, ancestors } from "../engine/dag.js";

// spec_json: { nodes:[{id,step,type,params}], edges:[{from,to}] }
const spec = {
  nodes: [
    { id: "n1", step: "shell", type: "shell", params: { image: "alpine" } },
    { id: "n2", step: "approval", type: "approval", params: { approver: "zhangsan" } },
    { id: "n3", step: "shell", type: "shell", params: { image: "alpine" } },
  ],
  edges: [
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3" },
  ],
};

test("buildGraph 记录入边与后继", () => {
  const g = buildGraph(spec);
  assert.deepEqual(g.successors.n1, ["n2"]);
  assert.deepEqual(g.successors.n2, ["n3"]);
  assert.deepEqual(g.parents.n3, ["n2"]);
});

test("nextReady 返回入边已全部完成的节点", () => {
  const g = buildGraph(spec);
  const done = new Set(["n1"]);
  assert.deepEqual(nextReady(g, done), ["n2"]);
});

test("nextReady 空入边（起点）总是就绪", () => {
  const g = buildGraph(spec);
  assert.deepEqual(nextReady(g, new Set()), ["n1"]);
});

test("ancestors 返回节点的前驱闭包（不含自身）", () => {
  const g = buildGraph({
    nodes: [
      { id: "n1", type: "shell" }, { id: "n2", type: "shell" }, { id: "n3", type: "shell" },
      { id: "n4", type: "shell" },
    ],
    edges: [ { from: "n1", to: "n3" }, { from: "n2", to: "n3" }, { from: "n3", to: "n4" } ],
  });
  assert.deepEqual([...ancestors(g, "n4")].sort(), ["n1", "n2", "n3"]);
});
test("ancestors 起点为空集", () => {
  const g = buildGraph({ nodes: [{ id: "n1", type: "shell" }], edges: [] });
  assert.deepEqual([...ancestors(g, "n1")], []);
});