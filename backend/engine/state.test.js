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
  // 第 1 轮（严格单轮语义）：只有根节点 t 就绪完成，branch 不首轮就绪执行
  const r1 = await adv.advanceOnce({ spec, snap: { done: [], environment: {}, trigger_raw: { k: "ok" } }, execId: 1, environment: new Map() });
  assert.ok(r1.snap.done.includes("t"), "首轮根节点 t 完成");
  assert.ok(!r1.snap.done.includes("b"), "branch 不在首轮同轮执行（单轮语义）");
  assert.deepEqual(records.filter((r) => r.status === "skipped"), [], "首轮无 skipped 记录");
  // 循环推进直到 completed：b 第 2 轮、j 第 3 轮
  let snap = r1.snap;
  let final = null;
  let guard = 0;
  for (;;) {
    const out = await adv.advanceOnce({ spec, snap, execId: 1, environment: new Map() });
    snap = out.snap;
    if (out.snap?.status === "completed" || out.waiting) { final = out; break; }
    if (++guard > 8) throw new Error("推进未收敛");
  }
  assert.equal(final.snap.status, "completed");
  assert.ok(final.snap.done.includes("j"), "join 最终完成（有激活入边，未被误判 dead）");
  assert.deepEqual(records.filter((r) => r.status === "skipped"), [], "全程无 skipped 记录");
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
  // 循环推进直到 completed：t 第 1 轮、b 第 2 轮，b 完成轮 dead 传播把 s/j 标记 skipped
  let snap = { done: [], environment: {}, trigger_raw: { k: "no" } };
  let final = null;
  let guard = 0;
  for (;;) {
    const out = await adv.advanceOnce({ spec, snap, execId: 2, environment: new Map() });
    snap = out.snap;
    if (out.snap?.status === "completed" || out.waiting) { final = out; break; }
    if (++guard > 8) throw new Error("推进未收敛");
  }
  assert.equal(final.snap.status, "completed");
  assert.ok(final.snap.done.includes("s"), "未命中边下游 s 记为 done(skipped)");
  assert.ok(final.snap.done.includes("j"), "join j 记为 done(skipped)");
  const skippedIds = records.filter((r) => r.status === "skipped").map((r) => r.nodeId);
  assert.deepEqual(skippedIds.sort(), ["j", "s"]);
});

test("branch：边条件按 $.outputs.<nodeId>.<field>（node_outputs）求值", async () => {
  const spec = {
    nodes: [
      { id: "t", type: "trigger", params: {} },
      { id: "p", type: "shell", params: {} },
      { id: "b", type: "branch", params: {} },
      { id: "s1", type: "sql", params: {} },
      { id: "s2", type: "sql", params: {} },
      { id: "j", type: "join", params: {} },
    ],
    edges: [
      { from: "t", to: "p" },
      { from: "p", to: "b" },
      { from: "b", to: "s1", cond: { path: "$.outputs.p.code", op: "eq", val: "0" } },
      { from: "b", to: "s2", cond: { path: "$.outputs.p.code", op: "eq", val: "1" } },
      { from: "s1", to: "j" },
      { from: "s2", to: "j" },
    ],
  };
  const ran = [];
  const records = [];
  const adv = createAdvancer({
    stepRun: async (node) => {
      ran.push(node.id);
      // shell 节点 p 产出 { code: "0" }，供 branch 边条件经 node_outputs 取数
      if (node.id === "p") return { kind: "done", output: { code: "0" } };
      return { kind: "done", output: {} };
    },
    snapshot: async () => {}, log: async () => {},
    record: async (r) => records.push(r),
  });
  // 第 1 轮 t、第 2 轮 p（产出 code=0）、第 3 轮 b 按 node_outputs.p.code 求值 → s1 执行 / s2 skipped、
  // 之后 j 收敛：循环推进直到 completed
  let snap = { done: [], environment: {} };
  let guard = 0;
  let final = null;
  for (;;) {
    const out = await adv.advanceOnce({ spec, snap, execId: 1, environment: new Map() });
    snap = out.snap;
    if (out.snap?.status === "completed" || out.waiting) { final = out; break; }
    if (++guard > 8) throw new Error("推进未收敛");
  }
  assert.equal(final.snap.status, "completed");
  assert.ok(ran.includes("s1"), "node_outputs 命中分支 s1 应执行");
  assert.ok(!ran.includes("s2"), "node_outputs 未命中分支 s2 不应执行");
  const skipped = records.filter((r) => r.status === "skipped").map((r) => r.nodeId);
  assert.deepEqual(skipped, ["s2"], "未命中边下游 s2 记 skipped");
});

// ---------- 控制节点：loop 迭代状态机 ----------

test("loop：非法 items（count 非数字）→ advanceOnce 以错误 reject，且 loop 节点有 failed 记录", async () => {
  const spec = {
    nodes: [
      { id: "t", type: "trigger", params: {} },
      { id: "l", type: "loop", params: { items: { count: "abc" }, accumulate: [] } },
      { id: "body", type: "sql", params: {} },
      { id: "j", type: "join", params: {} },
    ],
    edges: [{ from: "t", to: "l" }, { from: "l", to: "body" }, { from: "body", to: "j" }],
  };
  const records = [];
  const adv = createAdvancer({
    stepRun: async () => ({ kind: "done", output: {} }),
    snapshot: async () => {}, log: async () => {},
    record: async (r) => records.push(r),
  });
  // 首轮仅根节点 t 完成；第二轮 l 就绪，loop 初始化解析非法 count 抛错 → advanceOnce reject（而非裸 throw 逃逸后无失败落库）
  const r1 = await adv.advanceOnce({ spec, snap: { done: [], environment: {} }, execId: 13, environment: new Map() });
  await assert.rejects(
    () => adv.advanceOnce({ spec, snap: r1.snap, execId: 13, environment: new Map() }),
    /loop count 非法/
  );
  const failed = records.filter((r) => r.nodeId === "l" && r.status === "failed");
  assert.equal(failed.length, 1, "loop 初始化失败应落 failed 记录");
  assert.match(failed[0].output.error, /loop count 非法/);
});

function loopSpec() {
  return {
    nodes: [
      { id: "t", type: "trigger", params: {} },
      { id: "l", type: "loop", params: { items: { count: 3 }, accumulate: [{ key: "nums", from: "body", field: "n" }] } },
      { id: "body", type: "sql", params: { statements: ["select ${iteration}"] } },
      { id: "j", type: "join", params: {} },
    ],
    edges: [
      { from: "t", to: "l" },
      { from: "l", to: "body" },
      { from: "body", to: "j" },
    ],
  };
}

test("loop：count 迭代 3 轮，item/iteration 逐轮注入，accumulate 累积为数组，join 后 completed", async () => {
  const seenIter = [];
  const outRows = [];
  const adv = createAdvancer({
    stepRun: async (node, ctx) => {
      if (node.type === "sql") {
        seenIter.push(ctx.environment.get("iteration"));
        const n = Number(ctx.environment.get("iteration"));
        return { kind: "done", output: { n: n * 10 } };
      }
      return { kind: "done", output: {} };
    },
    snapshot: async () => {}, log: async () => {},
    record: async (r) => { if (r.status === "done") outRows.push(r); },
  });
  const spec = loopSpec();
  let snap = { done: [], environment: {} };
  let guard = 0;
  let final = null;
  for (;;) {
    const out = await adv.advanceOnce({ spec, snap, execId: 9, environment: new Map() });
    snap = out.snap;
    if (out.snap?.status === "completed" || out.waiting) { final = out; break; }
    if (++guard > 20) throw new Error("loop 推进未收敛");
  }
  assert.deepEqual(seenIter, ["1", "2", "3"], "迭代变量逐轮注入");
  // 循环体每轮输出累积为数组（n=10,20,30 → nums=["10","20","30"]）
  const loopRow = outRows.find((r) => r.nodeId === "l");
  assert.ok(loopRow, "loop 节点在结束时补记执行记录");
  assert.deepEqual(JSON.parse(loopRow.output.nums), [10, 20, 30]);
  assert.equal(final.snap.status, "completed");
});

test("loop：JSONPath 取数组（items.path），遍历逐项注入 item", async () => {
  const spec = {
    nodes: [
      { id: "t", type: "trigger", params: {} },
      { id: "l", type: "loop", params: { items: { path: "$.trigger.refs" }, accumulate: [] } },
      { id: "body", type: "sql", params: {} },
      { id: "j", type: "join", params: {} },
    ],
    edges: [{ from: "t", to: "l" }, { from: "l", to: "body" }, { from: "body", to: "j" }],
  };
  const seenItems = [];
  const adv = createAdvancer({
    stepRun: async (node, ctx) => {
      if (node.type === "sql") seenItems.push(ctx.environment.get("item"));
      return { kind: "done", output: {} };
    },
    snapshot: async () => {}, log: async () => {},
    record: async () => {},
  });
  let snap = { done: [], environment: {}, trigger_raw: { refs: ["a", "b"] } };
  let guard = 0;
  for (;;) {
    const out = await adv.advanceOnce({ spec, snap, execId: 10, environment: new Map() });
    snap = out.snap;
    if (out.snap?.status === "completed" || out.waiting) break;
    if (++guard > 20) throw new Error("loop 推进未收敛");
  }
  assert.deepEqual(seenItems, ["a", "b"]);
});

test("loop：items 为空数组 → body 全部 skipped，loop 完成，join 收敛后正常 completed", async () => {
  const spec = {
    nodes: [
      { id: "t", type: "trigger", params: {} },
      { id: "l", type: "loop", params: { items: { path: "$.trigger.refs" }, accumulate: [] } },
      { id: "body", type: "sql", params: {} },
      { id: "j", type: "join", params: {} },
    ],
    edges: [{ from: "t", to: "l" }, { from: "l", to: "body" }, { from: "body", to: "j" }],
  };
  const records = [];
  const adv = createAdvancer({
    stepRun: async () => ({ kind: "done", output: {} }),
    snapshot: async () => {}, log: async () => {},
    record: async (r) => records.push(r),
  });
  let snap = { done: [], environment: {}, trigger_raw: { refs: [] } };
  let guard = 0;
  let final = null;
  for (;;) {
    const out = await adv.advanceOnce({ spec, snap, execId: 11, environment: new Map() });
    snap = out.snap;
    if (out.snap?.status === "completed" || out.waiting) { final = out; break; }
    if (++guard > 20) throw new Error("loop 推进未收敛");
  }
  assert.equal(final.snap.status, "completed");
  const skipped = records.filter((r) => r.status === "skipped").map((r) => r.nodeId);
  assert.deepEqual(skipped, ["body"], "空迭代时循环体被跳过");
  const loopRow = records.find((r) => r.nodeId === "l" && r.status === "done");
  assert.ok(loopRow, "loop 节点完成（空迭代输出为空）");
});

test("loop：循环结束后 item/iteration 从环境移除（不污染下游）", async () => {
  const spec = {
    nodes: [
      { id: "t", type: "trigger", params: {} },
      { id: "l", type: "loop", params: { items: { count: 1 }, accumulate: [] } },
      { id: "body", type: "sql", params: {} },
      { id: "j", type: "join", params: {} },
      { id: "tail", type: "sql", params: { statements: ["select 1"] } },
    ],
    edges: [
      { from: "t", to: "l" }, { from: "l", to: "body" }, { from: "body", to: "j" }, { from: "j", to: "tail" },
    ],
  };
  let tailEnv = null;
  const adv = createAdvancer({
    stepRun: async (node, ctx) => {
      if (node.id === "tail") tailEnv = { ...Object.fromEntries(ctx.environment) };
      return { kind: "done", output: {} };
    },
    snapshot: async () => {}, log: async () => {},
    record: async () => {},
  });
  let snap = { done: [], environment: {} };
  let guard = 0;
  for (;;) {
    const out = await adv.advanceOnce({ spec, snap, execId: 12, environment: new Map() });
    snap = out.snap;
    if (out.snap?.status === "completed" || out.waiting) break;
    if (++guard > 20) throw new Error("loop 推进未收敛");
  }
  assert.equal(tailEnv.item, undefined);
  assert.equal(tailEnv.iteration, undefined);
});