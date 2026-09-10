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

test("webhook 触发的等价链路：装配层造好 spec 后 run 首次推进并派发 shell", async () => {
  // 生产链路：hook.webhook → hydrateForRun(loadSpec 读 spec + 开执行拿到 execId) → orchestrator.run
  // （orchestrator 中历史遗留的 git 命名触发方法已作为无调用方的死代码删除，此用例改为直接走 run 的等价断言）
  const calls = [];
  const adv = async ({ spec, snap }) => {
    calls.push(["advance", spec.execId, snap]);
    return { spec, snap: { done: [], waiting: "n1" }, waiting: "n1" };
  };
  const deps = fakeDeps({ advance: adv });
  const orch = createOrchestrator(deps);
  const specWithExec = { ...(await deps.loadSpec(1, { trigger: "webhook", body: { ref: "main" } })), execId: 11 };
  const out = await orch.run(specWithExec);
  assert.equal(out.waiting, "n1");
  // 新执行先清同 id 旧快照，再带着 execId 推进一次
  assert.deepEqual(deps.calls.filter((c) => c[0] === "clear"), [["clear", 11]]);
  assert.deepEqual(calls.map((c) => c[1]), [11]);
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

test("run 传入 environment Map：advance 收到的 environment 含外部变量，且快照兜底被外部覆盖", async () => {
  let captured = null;
  const adv = async (arg) => { captured = arg; return { spec: arg.spec, snap: arg.snap, waiting: null }; };
  // 快照里已有基础环境，验证 run 先恢复快照、再以外部同名覆盖
  const deps = fakeDeps({ advance: adv });
  deps.snapshotStore.load = async () => ({ done: [], waiting: null, environment: { x: "0", y: "9" } });
  const orch = createOrchestrator({ ...deps });
  const env = new Map([["x", "1"], ["z", "3"]]);
  await orch.run(spec, env);
  assert.equal(captured.environment.get("x"), "1"); // 外部覆盖快照 x=0
  assert.equal(captured.environment.get("y"), "9"); // 快照兜底保留
  assert.equal(captured.environment.get("z"), "3"); // 外部新增
});

test("run 无 environment：advance 收到的是从快照 environment 恢复的 Map", async () => {
  let captured = null;
  const adv = async (arg) => { captured = arg; return { spec: arg.spec, snap: arg.snap, waiting: null }; };
  const deps = fakeDeps({ advance: adv });
  deps.snapshotStore.load = async () => ({ done: [], waiting: null, environment: { k: "v" } });
  const orch = createOrchestrator({ ...deps });
  await orch.run(spec);
  assert.equal(captured.environment.get("k"), "v");
});

test("markDone 写回快照透传 environment，与读入一致", async () => {
  const deps = fakeDeps({ advance: async () => ({}) });
  let saved = null;
  deps.snapshotStore.save = async (id, s) => { saved = s; };
  deps.snapshotStore.load = async () => ({ done: [], waiting: null, environment: { x: "1" } });
  const orch = createOrchestrator({ ...deps });
  await orch.onEciDone({ execId: 1, nodeId: "n1" });
  assert.deepEqual(saved.environment, { x: "1" }); // save 捕获入参含 environment
});

test("eciDone：解析 K=V output 写回 environment，后继节点可见（FC 冻结下回调返回前必须完成）", async () => {
  const spec = {
    execId: 1,
    nodes: [
      { id: "a", type: "shell", params: { outputs: [{ key: "src" }], command: "echo src=abc" } },
      { id: "b", type: "approval", params: { message: "src=${src}" } },
    ],
    edges: [["a", "b"]],
  };
  let advancedEnv = null;
  const orchestrator = createOrchestrator({
    loadSpecForExec: async () => spec,
    snapshotStore: { load: async () => ({ done: [], waiting: null, environment: {} }), save: async () => {}, clear: async () => {} },
    advance: async ({ environment }) => { advancedEnv = Object.fromEntries(environment); return { status: "completed" }; },
    record: async () => {},
  });
  await orchestrator.onEciDone({ execId: 1, nodeId: "a", output: "git_sha=9f1c\nsrc=abc", logs: "# run\necho hi" });
  assert.equal(advancedEnv.src, "abc", "A 的输出 src=abc 必须写回 environment 供 B 引用");
});

test("跨回调续跑不丢 environment：markDone 后接续的 advance 入参仍含已累积变量", async () => {
  let captured = null;
  const adv = async (arg) => { captured = arg; return { spec: arg.spec, snap: arg.snap, waiting: "n2" }; };
  const deps = fakeDeps({ loadSpecForExec: async (execId) => ({ execId, ...spec }), advance: adv });
  // 模拟：run 已推进累积 x=1 写入快照 → 回调 onEciDone → 续跑 advance 仍带 x=1
  deps.snapshotStore.load = async () => ({ done: ["n1"], waiting: "n2", environment: { x: "1" } });
  const orch = createOrchestrator({ ...deps });
  await orch.onEciDone({ execId: 1, nodeId: "n1" });
  assert.equal(captured.environment.get("x"), "1"); // 续跑入参不丢
});