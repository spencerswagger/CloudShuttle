import test from "node:test";
import assert from "node:assert/strict";
import { createAdvancer } from "./state.js";

// 本地内存锁（无 redis）：acquire 成功则返回 true，互斥用 Promise 队列实现
function localMutex() {
  let busy = false;
  const queue = [];
  return {
    async acquire() {
      if (!busy) { busy = true; return true; }
      return new Promise((res) => queue.push(() => { busy = false; res(true); }));
    },
    async release() { const next = queue.shift(); if (next) { busy = false; next(); } else busy = false; },
  };
}

function makeSpec() {
  const n = (id, type = "done") => ({ id, type, params: {} });
  return {
    nodes: [n("a", "sync"), n("b", "sync"), n("c", "sync")],
    edges: [{ from: "a", to: "c" }, { from: "b", to: "c" }],
  };
}

// 并发 stepRun：记录运行窗口重叠。同轮多个无依赖节点应真并发执行。
function concurrentStepRun({ win = 30 } = {}) {
  const active = new Set();
  let overlap = false;
  const stepRun = async (node) => {
    active.add(node.id);
    await new Promise((r) => setTimeout(r, win));
    if ([...active].some((x) => x !== node.id)) overlap = true;
    active.delete(node.id);
    return { kind: "done", output: { [node.id]: "ok" }, logs: node.id };
  };
  return { stepRun, isOverlap: () => overlap };
}

test("两无依赖就绪节点真并发执行（运行窗口重叠）", async () => {
  const { stepRun, isOverlap } = concurrentStepRun();
  const recorded = [];
  const adv = createAdvancer({
    stepRun, mutex: localMutex(),
    snapshot: async (e, s) => {}, record: async (r) => { recorded.push(r); },
    complete: async () => {}, log: async () => {},
  });
  // 单次 advanceOnce 只推进一轮：a、b 无依赖就绪并发跑，c 依赖 a/b 本轮不执行
  const res = await adv.advanceOnce({ spec: makeSpec(), snap: { done: [], environment: {} }, execId: 1, environment: new Map() });
  assert.equal(isOverlap(), true, "同轮无依赖节点未重叠执行（仍是串行）");
  assert.equal(res.snap.done.length, 2, "一轮后 a、b 就绪完成，c 因依赖未 ready 不执行");
  assert.deepEqual(recorded.map((x) => x.nodeId).sort(), ["a", "b"].sort());
});

test("串行链路回归：a→b 前一完成才执行后一（无重叠）", async () => {
  const { stepRun, isOverlap } = concurrentStepRun({ win: 20 });
  const adv = createAdvancer({
    stepRun, mutex: localMutex(),
    snapshot: async () => {}, record: async () => {}, complete: async () => {}, log: async () => {},
  });
  const spec = { nodes: [{ id: "a", type: "sync", params: {} }, { id: "b", type: "sync", params: {} }], edges: [{ from: "a", to: "b" }] };
  await adv.advanceOnce({ spec, snap: { done: [], environment: {} }, execId: 2, environment: new Map() });
  assert.equal(isOverlap(), false);
});

test("同轮多个 shell（dispatch）节点都派发且都进 waiting（多 ECI 并行）", async () => {
  const order = [];
  const stepRun = async (node) => {
    order.push(node.id);
    return { kind: "dispatch", ref: `tok-${node.id}` };
  };
  const recorded = [];
  const adv = createAdvancer({
    stepRun, mutex: localMutex(),
    snapshot: async () => {}, record: async (r) => { recorded.push(r); },
    complete: async () => {}, log: async () => {},
  });
  // a、b 均为根节点（无边），同轮就绪；都属 dispatch 类（shell）→ 本轮应全部派发、全部进 waiting
  const spec = {
    nodes: [{ id: "a", type: "shell", params: {} }, { id: "b", type: "shell", params: {} }],
    edges: [],
  };
  const res = await adv.advanceOnce({ spec, snap: { done: [], environment: {} }, execId: 4, environment: new Map() });
  assert.deepEqual(order, ["a", "b"], "同轮 dispatch 类节点应全部派发（a、b 各自独立 ECI 容器）");
  assert.deepEqual(res.waiting, ["a", "b"], "两个已派发节点都进 waiting 集合");
  assert.ok(!res.snap.done.includes("a") && !res.snap.done.includes("b"), "dispatch 节点未 done");
  assert.deepEqual(recorded.map((x) => x.nodeId), ["a", "b"], "a、b 都进入 dispatch 记录");
});

test("同轮多个 approval（wait 类）节点都派发且都进 waiting", async () => {
  const order = [];
  const stepRun = async (node) => {
    order.push(node.id);
    return { kind: "wait", ref: `tok-${node.id}` };
  };
  const recorded = [];
  const adv = createAdvancer({
    stepRun, mutex: localMutex(),
    snapshot: async () => {}, record: async (r) => { recorded.push(r); },
    complete: async () => {}, log: async () => {},
  });
  // a、b 均为根节点（无边），同轮就绪；都属 wait 类（approval，返回 kind:'wait'）→ 本轮应全部派发
  const spec = {
    nodes: [{ id: "a", type: "approval", params: {} }, { id: "b", type: "approval", params: {} }],
    edges: [],
  };
  const res = await adv.advanceOnce({ spec, snap: { done: [], environment: {} }, execId: 5, environment: new Map() });
  assert.deepEqual(order, ["a", "b"], "同轮 wait 类节点应全部派发（a、b 各自独立审批卡片）");
  assert.deepEqual(res.waiting, ["a", "b"], "两个已派发 wait 节点都进 waiting 集合");
  assert.deepEqual(recorded.map((x) => x.nodeId), ["a", "b"], "a、b 都进入 wait 记录");
});

test("dispatch 节点：本轮结束等待回调，后续节点不推进", async () => {
  const order = [];
  const stepRun = async (node) => {
    order.push(node.id);
    if (node.id === "a") return { kind: "dispatch", ref: "tok-a" };
    return { kind: "done", output: {}, logs: node.id };
  };
  const adv = createAdvancer({
    stepRun, mutex: localMutex(),
    snapshot: async () => {}, record: async () => {}, complete: async () => {}, log: async () => {},
  });
  const spec = { nodes: [{ id: "a", type: "shell", params: {} }, { id: "b", type: "sql", params: {} }], edges: [{ from: "a", to: "b" }] };
  const res = await adv.advanceOnce({ spec, snap: { done: [], environment: {} }, execId: 3, environment: new Map() });
  assert.deepEqual(res.waiting, ["a"], "a 派发等待则 b 不应执行");
  assert.deepEqual(order, ["a"], "b 依赖 a，a 派发等待则 b 不应执行");
});

test("旧快照 waiting 为单值字符串时兼容归一为数组", async () => {
  const stepRun = async (node) => ({ kind: "done", output: {}, logs: node.id });
  const saved = [];
  const adv = createAdvancer({
    stepRun, mutex: localMutex(),
    snapshot: async (_id, s) => { saved.push(s); }, record: async () => {}, complete: async () => {}, log: async () => {},
  });
  const spec = { nodes: [{ id: "a", type: "shell", params: {} }, { id: "b", type: "sql", params: {} }], edges: [{ from: "a", to: "b" }] };
  // 旧快照 waiting="a"（字符串）：advanceOnce 顶部应识别为有等待 → 本轮不推进
  const res = await adv.advanceOnce({ spec, snap: { done: [], waiting: "a", environment: {} }, execId: 6, environment: new Map() });
  assert.deepEqual(res.waiting, ["a"], "字符串 waiting 归一为数组");
  assert.equal(saved.length, 0, "有等待时本轮不推进也不写快照");
});

// ---------- 控制节点：branch 边条件剪枝 / dead 传播 / join 收敛 ----------
function branchSpec() {
  return {
    nodes: [
      { id: "t", type: "trigger", params: {} },
      { id: "b", type: "branch", params: {} },
      { id: "s1", type: "sql", params: { statements: ["select 1"] } },
      { id: "s2", type: "sql", params: { statements: ["select 2"] } },
      { id: "j", type: "join", params: {} },
    ],
    edges: [
      { from: "t", to: "b" },
      { from: "b", to: "s1", cond: { path: "$.trigger.branch", op: "eq", val: "release" } },
      { from: "b", to: "s2", cond: { path: "$.trigger.branch", op: "eq", val: "dev" } },
      { from: "s1", to: "j" },
      { from: "s2", to: "j" },
    ],
  };
}

test("branch：命中边的下游执行，未命中边下游记 skipped，join 收敛后 completed", async () => {
  const ran = [];
  const records = [];
  const adv = createAdvancer({
    stepRun: async (node) => { ran.push(node.id); return { kind: "done", output: { ran: node.id } }; },
    snapshot: async () => {}, log: async () => {},
    record: async (r) => records.push(r),
  });
  let snap = { done: [], environment: {}, trigger_raw: { branch: "release" } };
  let guard = 0;
  let final = null;
  for (;;) {
    const out = await adv.advanceOnce({ spec: branchSpec(), snap, execId: 1, environment: new Map() });
    snap = out.snap;
    if (out.snap?.status === "completed" || out.waiting) { final = out; break; }
    if (++guard > 8) throw new Error("推进未收敛");
  }
  assert.equal(final.snap.status, "completed");
  assert.deepEqual(ran.sort(), ["b", "j", "s1", "t"], "命中分支与 join 执行（s2 不执行）");
  const skipped = records.filter((r) => r.status === "skipped").map((r) => r.nodeId);
  assert.deepEqual(skipped, ["s2"], "未命中分支被跳过");
});

test("branch：命中边 target 为 join 时 join 不被误判 dead（有激活入边）", async () => {
  const spec = {
    nodes: [
      { id: "t", type: "trigger", params: {} },
      { id: "b", type: "branch", params: {} },
      { id: "j", type: "join", params: {} },
    ],
    edges: [
      { from: "t", to: "b" },
      { from: "b", to: "j", cond: { path: "$.trigger.k", op: "eq", val: "ok" } },
    ],
  };
  const records = [];
  const adv = createAdvancer({
    stepRun: async () => ({ kind: "done", output: {} }),
    snapshot: async () => {}, log: async () => {},
    record: async (r) => records.push(r),
  });
  // 第 1 轮：t、b 都 done；条件命中 → 无 skipped；j 未就绪
  const r1 = await adv.advanceOnce({ spec, snap: { done: [], environment: {}, trigger_raw: { k: "ok" } }, execId: 1, environment: new Map() });
  assert.equal(r1.snap.done.includes("j"), false);
  assert.deepEqual(records.filter((r) => r.status === "skipped"), []);
  // 第 2 轮：j 就绪并完成 → completed
  const r2 = await adv.advanceOnce({ spec, snap: r1.snap, execId: 1, environment: new Map() });
  assert.equal(r2.snap.status, "completed");
});

test("branch：条件未命中 → 下游全部 skipped，执行仍 completed（无匹配即跳过语义）", async () => {
  const spec = {
    nodes: [
      { id: "t", type: "trigger", params: {} },
      { id: "b", type: "branch", params: {} },
      { id: "s", type: "sql", params: {} },
      { id: "j", type: "join", params: {} },
    ],
    edges: [
      { from: "t", to: "b" },
      { from: "b", to: "s", cond: { path: "$.trigger.k", op: "eq", val: "yes" } },
      { from: "s", to: "j" },
    ],
  };
  const records = [];
  const adv = createAdvancer({
    stepRun: async () => ({ kind: "done", output: {} }),
    snapshot: async () => {}, log: async () => {},
    record: async (r) => records.push(r),
  });
  const r1 = await adv.advanceOnce({ spec, snap: { done: [], environment: {}, trigger_raw: { k: "no" } }, execId: 2, environment: new Map() });
  // 本轮内 t/b done，s/j 被标记 skipped
  assert.ok(r1.snap.done.includes("s"));
  assert.ok(r1.snap.done.includes("j"));
  const skippedIds = records.filter((r) => r.status === "skipped").map((r) => r.nodeId);
  assert.deepEqual(skippedIds.sort(), ["j", "s"]);
  // 全部 done → 下一轮 completed
  const r2 = await adv.advanceOnce({ spec, snap: r1.snap, execId: 2, environment: new Map() });
  assert.equal(r2.snap.status, "completed");
});