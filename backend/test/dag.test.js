// backend/test/dag.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, nextReady } from "../engine/dag.js";

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