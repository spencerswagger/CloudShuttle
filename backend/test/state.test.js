import { test } from "node:test";
import assert from "node:assert/strict";
import { createAdvancer } from "../engine/state.js";

const spec = {
  nodes: [
    { id: "n1", step: "shell", type: "shell", params: { image: "alpine", command: "echo hi" } },
    { id: "n2", step: "approval", type: "approval", params: { approver: "zhangsan" } },
  ],
  edges: [{ from: "n1", to: "n2" }],
};

// 注入 stepRun 以便单测；真实步骤见 Task 8/9
function stepRun(node, ctx) {
  if (node.type === "shell") return { kind: "dispatch", ref: "job-1" };
  if (node.type === "approval") return { kind: "wait", ref: "tok" };
  return { kind: "done" };
}

test("起点推进：shell 节点派发而非完成全部", async () => {
  let recorded = null;
  const adv = createAdvancer({
    stepRun,
    snapshot: async () => {},
    record: async (r) => { recorded = r; },
  });
  const out = await adv.advanceOnce({ spec, snap: { done: new Set(), waiting: null } });
  assert.equal(out.waiting, "n1");
  assert.equal(recorded.status, "dispatch"); // stepRun 派发并记 record
  assert.ok(!out.snap.done.has("n1"));        // 未标记完成
});

test("空入边起点在无等待节点的图上同步完成", async () => {
  const spec2 = { nodes: [{ id: "a", step: "x", type: "x", params: {} }], edges: [] };
  const adv = createAdvancer({
    stepRun: () => ({ kind: "done" }),
    snapshot: async () => {}, record: async () => {},
  });
  const out = await adv.advanceOnce({ spec: spec2, snap: { done: new Set(), waiting: null } });
  assert.ok(out.snap.done.has("a"));
  assert.equal(out.waiting, null);
});