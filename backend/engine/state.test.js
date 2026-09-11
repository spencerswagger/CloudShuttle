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
  assert.equal(res.snap.done.size, 2, "一轮后 a、b 就绪完成，c 因依赖未 ready 不执行");
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

test("同轮多个 shell（dispatch）节点仅派发一个，其余后续轮再执行", async () => {
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
  // a、b 均为根节点（无边），同轮就绪；都属 dispatch 类（shell）→ 本轮应只派发一个
  const spec = {
    nodes: [{ id: "a", type: "shell", params: {} }, { id: "b", type: "shell", params: {} }],
    edges: [],
  };
  const res = await adv.advanceOnce({ spec, snap: { done: [], environment: {} }, execId: 4, environment: new Map() });
  assert.deepEqual(order, ["a"], "同轮 dispatch 类节点应只派发一个（a），b 本轮不应被调用");
  assert.equal(res.waiting, "a", "第一个被派发的 dispatch 节点成为 waiting");
  assert.ok(!res.snap.done.has("a") && !res.snap.done.has("b"), "dispatch 节点未 done");
  assert.deepEqual(recorded.map((x) => x.nodeId), ["a"], "仅 a 进入 dispatch/wait 记录");
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
  assert.equal(res.waiting, "a");
  assert.deepEqual(order, ["a"], "b 依赖 a，a 派发等待则 b 不应执行");
});