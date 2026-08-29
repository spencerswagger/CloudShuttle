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

// ---------- environment 维度 ----------

test("预填 environment 时 shell 节点 command 预渲染 ${x}", async () => {
  const env = new Map();
  env.set("x", "1");
  let stepNode = null;
  const adv = createAdvancer({
    stepRun: (node) => { stepNode = node; return { kind: "dispatch", ref: "j1" }; },
    snapshot: async () => {}, record: async () => {},
  });
  const specX = {
    nodes: [{ id: "s1", step: "shell", type: "shell", params: { image: "alpine", command: "echo ${x}" } }],
    edges: [],
  };
  await adv.advanceOnce({ spec: specX, snap: { done: new Set(), waiting: null }, environment: env });
  // stepRun 收到的是渲染后的节点副本：command 已替换为 1，且保留原 id/type
  assert.equal(stepNode.params.command, "echo 1");
  assert.equal(stepNode.id, "s1");
  assert.equal(stepNode.type, "shell");
  // 原始 spec 不被污染
  assert.equal(specX.nodes[0].params.command, "echo ${x}");
});

test("节点 done 的 output 写入快照 environment", async () => {
  let snapArg = null;
  const adv = createAdvancer({
    stepRun: () => ({ kind: "done", output: { out1: "v" } }),
    snapshot: async (_execId, s) => { snapArg = s; },
    record: async () => {},
  });
  const specO = { nodes: [{ id: "o1", step: "x", type: "shell", params: {} }], edges: [] };
  await adv.advanceOnce({ spec: specO, snap: { done: new Set(), waiting: null } });
  // 同步 done → 进入 completed 分支，仍携带 environment
  assert.equal(snapArg.status, "completed");
  assert.equal(snapArg.environment.out1, "v");
});

test("从 snap.environment 恢复供节点渲染 ${prev}", async () => {
  let stepNode = null;
  const adv = createAdvancer({
    stepRun: (node) => { stepNode = node; return { kind: "dispatch", ref: "j1" }; },
    snapshot: async () => {}, record: async () => {},
  });
  const specP = { nodes: [{ id: "p1", step: "shell", type: "shell", params: { command: "echo ${prev}" } }], edges: [] };
  await adv.advanceOnce({
    spec: specP,
    snap: { done: new Set(), waiting: null, environment: { prev: "2" } },
  });
  assert.equal(stepNode.params.command, "echo 2");
});

test("外部 environment 与 snap.environment 同名冲突时外部优先", async () => {
  const env = new Map();
  env.set("k", "EXT");
  let stepNode = null;
  const adv = createAdvancer({
    stepRun: (node) => { stepNode = node; return { kind: "dispatch", ref: "j1" }; },
    snapshot: async () => {}, record: async () => {},
  });
  const specK = { nodes: [{ id: "k1", step: "shell", type: "shell", params: { command: "echo ${k}" } }], edges: [] };
  await adv.advanceOnce({
    spec: specK,
    snap: { done: new Set(), waiting: null, environment: { k: "SNAP" } },
    environment: env,
  });
  assert.equal(stepNode.params.command, "echo EXT"); // 外部传入覆盖快照中的同名
});

test("env 数组每个元素的 v 字段被预渲染", async () => {
  const env = new Map();
  env.set("p", "3");
  let stepNode = null;
  const adv = createAdvancer({
    stepRun: (node) => { stepNode = node; return { kind: "dispatch", ref: "j1" }; },
    snapshot: async () => {}, record: async () => {},
  });
  const specE = {
    nodes: [{ id: "e1", step: "shell", type: "shell", params: { command: "x", env: [{ k: "A", v: "val-${p}" }] } }],
    edges: [],
  };
  await adv.advanceOnce({ spec: specE, snap: { done: new Set(), waiting: null }, environment: env });
  assert.equal(stepNode.params.env[0].v, "val-3");
});

test("stepRun 收到 ctx.environment（扁平变量地图 Map）", async () => {
  const env = new Map();
  env.set("pipeline_name", "demo");
  let ctxArg = null;
  const adv = createAdvancer({
    stepRun: (node, ctx) => { ctxArg = ctx; return { kind: "dispatch", ref: "j1" }; },
    snapshot: async () => {}, record: async () => {},
  });
  const specE = { nodes: [{ id: "s1", step: "shell", type: "shell", params: {} }], edges: [] };
  await adv.advanceOnce({ spec: specE, snap: { done: new Set(), waiting: null }, environment: env });
  assert.ok(ctxArg.environment instanceof Map);
  assert.equal(ctxArg.environment.get("pipeline_name"), "demo");
});

// ---------- 深 walk 渲染作用域一致（与 collectNodeDeps 对齐）----------

test("嵌套对象字符串字段(如 params.script.body)被深渲染且原始 spec 不被污染", async () => {
  const env = new Map();
  env.set("x", "1");
  let stepNode = null;
  const adv = createAdvancer({
    stepRun: (node) => { stepNode = node; return { kind: "dispatch", ref: "j1" }; },
    snapshot: async () => {}, record: async () => {},
  });
  const specN = {
    nodes: [{ id: "n1", step: "shell", type: "shell", params: { script: { body: "echo ${x}" }, command: "run ${x}" } }],
    edges: [],
  };
  await adv.advanceOnce({ spec: specN, snap: { done: new Set(), waiting: null }, environment: env });
  assert.equal(stepNode.params.script.body, "echo 1");
  assert.equal(stepNode.params.command, "run 1");
  // 原始 spec 嵌套层不被污染
  assert.equal(specN.nodes[0].params.script.body, "echo ${x}");
});

test("env 数组元素用 value 字段也被深渲染", async () => {
  const env = new Map();
  env.set("k", "9");
  let stepNode = null;
  const adv = createAdvancer({
    stepRun: (node) => { stepNode = node; return { kind: "dispatch", ref: "j1" }; },
    snapshot: async () => {}, record: async () => {},
  });
  const specV = {
    nodes: [{ id: "v1", step: "shell", type: "shell", params: { command: "x", env: [{ k: "A", value: "pool-${k}" }] } }],
    edges: [],
  };
  await adv.advanceOnce({ spec: specV, snap: { done: new Set(), waiting: null }, environment: env });
  assert.equal(stepNode.params.env[0].value, "pool-9");
});

test("outputs 子树不被渲染传递", async () => {
  const env = new Map();
  env.set("k", "7");
  let stepNode = null;
  const adv = createAdvancer({
    stepRun: (node) => { stepNode = node; return { kind: "dispatch", ref: "j1" }; },
    snapshot: async () => {}, record: async () => {},
  });
  const specOut = {
    nodes: [{ id: "o1", step: "shell", type: "shell", params: { command: "echo ${k}", outputs: [{ key: "ok", value: "${k}" }] } }],
    edges: [],
  };
  await adv.advanceOnce({ spec: specOut, snap: { done: new Set(), waiting: null }, environment: env });
  assert.equal(stepNode.params.command, "echo 7");
  // outputs 声明原样保留，值不被替换（不作为待渲染正文）
  assert.deepEqual(stepNode.params.outputs, [{ key: "ok", value: "${k}" }]);
});