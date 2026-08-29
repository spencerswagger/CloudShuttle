import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator } from "../engine/orchestrator.js";

const spec = {
  nodes: [
    { id: "n1", step: "shell", type: "shell", params: {} },
    { id: "n2", step: "approval", type: "approval", params: {} },
  ],
  edges: [{ from: "n1", to: "n2" }],
};

function fakeDeps(over = {}) {
  const calls = [];
  return {
    calls,
    loadSpec: over.loadSpec ?? (async () => spec),
    loadSpecForExec: over.loadSpecForExec,
    snapshotStore: {
      save: async (id, s) => calls.push(["save", id, s]),
      load: async () => calls.push(["load"]) && ({ done: [], waiting: null }),
      clear: async (id) => calls.push(["clear", id]),
    },
    advance: over.advance,
    record: over.record ?? (async () => {}),
  };
}

test("gitWebhook 触发首次推进并派发 shell", async () => {
  const adv = async ({ spec, snap }) => {
    return { spec, snap: { done: [], waiting: "n1" }, waiting: "n1" };
  };
  const orch = createOrchestrator({ ...fakeDeps(), advance: adv });
  const out = await orch.onGitWebhook({ pipelineId: 1, trigger: { ref: "main" } });
  assert.equal(out.waiting, "n1");
});

test("eciDone 标记节点后推进到审批卡点", async () => {
  // eciDone(execId, nodeId=等待中的节点)：先把该节点 done，再把 waiting 置 null
  // 并写回快照，然后推进找到下一个 ready（此处为审批卡点 n2）
  const deps = fakeDeps({ loadSpecForExec: async (execId) => ({ execId, ...spec }) });
  let saved = null;
  deps.snapshotStore.save = async (id, s) => { saved = s; deps.calls.push(["save", id, s]); };
  const adv = async ({ spec, snap }) => {
    assert.ok(snap.done.includes("n1"));
    return { spec, snap: { done: ["n1"], waiting: "n2" }, waiting: "n2" };
  };
  const orch = createOrchestrator({ ...deps, advance: adv });
  const out = await orch.onEciDone({ execId: 1, nodeId: "n1" });
  assert.equal(out.waiting, "n2");
  // 快照在 advance 前已写回：n1 标记 done、waiting 清空
  assert.deepEqual(saved, { done: ["n1"], waiting: null });
});

test("onApproval approve 续跑到下一节点", async () => {
  const deps = fakeDeps({ loadSpecForExec: async (execId) => ({ execId, ...spec }) });
  let saved = null;
  deps.snapshotStore.save = async (id, s) => { saved = s; deps.calls.push(["save", id, s]); };
  const adv = async () => ({ waiting: "n2" });
  const orch = createOrchestrator({ ...deps, advance: adv });
  const out = await orch.onApproval({ execId: 1, nodeId: "n1", decision: "approve" });
  assert.equal(out.waiting, "n2");
  assert.deepEqual(saved, { done: ["n1"], waiting: null });
});

test("onApproval reject 终止执行", async () => {
  const deps = fakeDeps();
  let saved = null;
  deps.snapshotStore.save = async (id, s) => { saved = s; };
  const orch = createOrchestrator({ ...deps });
  const out = await orch.onApproval({ execId: 1, nodeId: "n1", decision: "reject" });
  assert.equal(out.status, "failed");
  assert.ok(saved.status === "failed");
});