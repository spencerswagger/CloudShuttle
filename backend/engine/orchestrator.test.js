// orchestrator 并发正确性测试：多 ECI 回调互斥续跑 + waiting 集合化（各自回调各自移除）
// 依赖注入本地内存锁（无 redis），验证锁真正串行化「markDone → 续跑」临界区。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator } from "./orchestrator.js";
import { createAdvancer } from "./state.js";

// 本地内存锁：acquire 排队等待（非轮询），release 唤醒队首；支持任意多个并发等待者
function localMutex() {
  let busy = false;
  const queue = [];
  return {
    async acquire() {
      if (!busy) { busy = true; return true; }
      return new Promise((res) => queue.push(() => res(true)));
    },
    async release() {
      const next = queue.shift();
      if (next) next(); else busy = false;
    },
  };
}

// 可读写的内存快照存储：save 落 cur，load 读 cur（模拟读己之写，逼近真实 redis 行为）
function memStore(initial = null) {
  let cur = initial;
  return {
    load: async () => cur,
    save: async (_id, s) => { cur = s; },
    clear: async () => { cur = null; },
  };
}

const baseDeps = (over = {}) => ({
  loadSpecForExec: over.loadSpecForExec ?? (async () => ({ execId: 1 })),
  snapshotStore: over.snapshotStore ?? memStore({ done: [], waiting: null }),
  advance: over.advance ?? (async ({ snap }) => ({ snap, waiting: null })),
  record: over.record ?? (async () => {}),
  failExecution: over.failExecution ?? (async () => {}),
  schedLog: over.schedLog ?? (async () => {}),
  mutex: over.mutex,
});

test("两个 ECI 回调并发到达时续跑串行化（mutex 生效，advance 不重叠）", async () => {
  const times = [];
  // 慢 advance：内部 25ms，若并发执行则两次起始时间几乎同时（<15ms 间隔）——锁必须把它们拉开
  const advance = async ({ snap }) => {
    times.push(Date.now());
    await new Promise((r) => setTimeout(r, 25));
    return { snap, waiting: null };
  };
  const orch = createOrchestrator(baseDeps({
    mutex: localMutex(),
    snapshotStore: memStore({ done: [], waiting: ["a", "b"] }),
    advance,
  }));
  await Promise.all([
    orch.onEciDone({ execId: 1, nodeId: "a", output: "x=1" }),
    orch.onEciDone({ execId: 1, nodeId: "b", output: "y=2" }),
  ]);
  assert.equal(times.length, 2, "两个回调各续跑一次");
  assert.ok(
    times[1] - times[0] >= 15,
    `两次 advance 应被锁串行化（起始间隔=${times[1] - times[0]}ms 应 >= 15ms）`
  );
});

test("回调只移除自己的 waiting：a 到后 waiting 剩 b，b 到后清空，且各自 advance 一次", async () => {
  const store = memStore({ done: [], waiting: ["a", "b"] });
  const saves = [];
  const origSave = store.save;
  store.save = async (id, s) => { saves.push(s); await origSave(id, s); };
  let advanceCount = 0;
  const orch = createOrchestrator(baseDeps({
    snapshotStore: store,
    // 让返回的 waiting 反映入参 snap（即 markDone 移除后的最新 waiting）
    advance: async ({ snap }) => { advanceCount++; return { snap, waiting: snap.waiting ?? null }; },
  }));
  const out1 = await orch.onEciDone({ execId: 1, nodeId: "a", output: "x=1" });
  assert.equal(advanceCount, 1, "a 回调后 advance 一次");
  assert.deepEqual(saves[0].done, ["a"], "a 已标记 done");
  assert.deepEqual(saves[0].waiting, ["b"], "a 回调只移除自己，waiting 剩 b");
  assert.deepEqual(out1.waiting, ["b"], "返回的 waiting 反映移除后的快照");
  const out2 = await orch.onEciDone({ execId: 1, nodeId: "b", output: "y=2" });
  assert.equal(advanceCount, 2, "b 回调后 advance 一次");
  assert.deepEqual(saves[1].done, ["a", "b"], "b 已标记 done");
  assert.equal(saves[1].waiting, null, "b 回调后 waiting 清空");
  assert.equal(out2.waiting, null);
});

test("onEciFail / onApproval 同样走锁（临界区互斥）", async () => {
  let lockCount = 0;
  const lock = {
    acquire: async () => { lockCount++; return true; },
    release: async () => {},
  };
  const orch = createOrchestrator(baseDeps({
    mutex: lock,
    snapshotStore: memStore({ done: [], waiting: ["a"] }),
  }));
  const failOut = await orch.onEciFail({ execId: 1, nodeId: "a", reason: "exit 1" });
  assert.equal(failOut.status, "failed", "ECI 失败回调 → 执行终态 failed");
  const appOut = await orch.onApproval({ execId: 1, nodeId: "a", decision: "approve" });
  assert.ok(appOut, "审批通过回调正常返回");
  assert.equal(lockCount, 2, "onEciFail 与 onApproval 各获取一次锁");
});

test("旧快照 waiting 为单值字符串时兼容（markDone 归一后只移除自己）", async () => {
  const store = memStore({ done: [], waiting: "a" }); // 旧格式：字符串
  const saves = [];
  const origSave = store.save;
  store.save = async (id, s) => { saves.push(s); await origSave(id, s); };
  const orch = createOrchestrator(baseDeps({ snapshotStore: store }));
  const out = await orch.onEciDone({ execId: 1, nodeId: "a", output: "x=1" });
  assert.deepEqual(saves[0].done, ["a"]);
  assert.equal(saves[0].waiting, null, "字符串 waiting 归一后移除该节点 → 无剩余等待");
  assert.equal(out.waiting, null);
});

test("多 ECI 全链路：同轮都派发都进 waiting → 回调各自移除 → 全部完成后 completed", async () => {
  // 用真实 createAdvancer 作为 advance，走完「派发 → 回调 → 续跑 → 完成」全流程
  const spec = {
    execId: 1,
    nodes: [
      { id: "a", type: "shell", params: {} },
      { id: "b", type: "shell", params: {} },
      { id: "c", type: "sql", params: {} },
    ],
    edges: [{ from: "a", to: "c" }, { from: "b", to: "c" }],
  };
  const stepRun = async (node) => {
    if (node.type === "shell") return { kind: "dispatch", ref: `tok-${node.id}` };
    return { kind: "done", output: { [node.id]: "ok" }, logs: node.id };
  };
  const store = memStore();
  const completed = [];
  const advancer = createAdvancer({
    stepRun,
    snapshot: async (id, s) => { await store.save(id, s); },
    record: async () => {},
    complete: async ({ status }) => { completed.push(status); },
    log: async () => {},
  });
  let advanceCalls = 0;
  const orch = createOrchestrator(baseDeps({
    mutex: localMutex(),
    loadSpecForExec: async () => spec,
    snapshotStore: store,
    advance: async (arg) => { advanceCalls++; return advancer.advanceOnce(arg); },
  }));
  // 1) 首轮：a、b 两个 shell 同轮全部派发，waiting=[a,b]（多 ECI 并行）
  const out1 = await orch.run(spec, new Map());
  assert.deepEqual(out1.waiting, ["a", "b"], "同轮两个 shell 都派发且都进 waiting");
  assert.equal(advanceCalls, 1);
  // 2) a 回调：只移除 a，waiting 剩 b；advance 因仍有等待节点而不推进（屏障）
  const out2 = await orch.onEciDone({ execId: 1, nodeId: "a", output: "x=1" });
  assert.deepEqual(out2.waiting, ["b"], "a 回调后 waiting 只剩 b");
  assert.equal(advanceCalls, 2);
  // 3) b 回调：移除 b，waiting 空 → c 就绪并完成 → 执行 completed
  const out3 = await orch.onEciDone({ execId: 1, nodeId: "b", output: "y=2" });
  assert.equal(out3.waiting, null, "b 回调后无剩余等待");
  assert.equal(out3.snap.status, "completed", "依赖全部满足后执行完成");
  assert.deepEqual(completed, ["completed"], "complete 回调被调用一次");
  assert.equal(advanceCalls, 3, "run + 两次回调各推进一次，无重复推进");
});

test("并行回调：中间回调的输出持久化，下游变量解析成功（回归：x=1 不丢失）", async () => {
  // 缺陷机理：a、b 并行派发 → a 先回 x=1（中间回调）→ b 后回 y=2 → c 引用 ${x}。
  // 旧实现 a 回调的 advance 因 waiting=[b] 非空早退且不写快照，x=1 从未落库；
  // b 回调的 markDone 从 store 读回旧快照 environment，c 渲染时 ${x} 原样保留 → 静默产出错误数据。
  // 本用例必须断言下游渲染后的 params（done 型 E2E 用例只断言 waiting，抓不到此缺陷）。
  const spec = {
    execId: 1,
    nodes: [
      { id: "a", type: "shell", params: {} },
      { id: "b", type: "shell", params: {} },
      { id: "c", type: "sql", params: { sql: "select ${x} + ${y} as total" } },
    ],
    edges: [{ from: "a", to: "c" }, { from: "b", to: "c" }],
  };
  const rendered = {}; // nodeId -> 该节点执行时收到的渲染后 params
  const stepRun = async (node) => {
    if (node.type === "shell") return { kind: "dispatch", ref: `tok-${node.id}` };
    rendered[node.id] = node.params; // sql 节点：捕获渲染后的 params
    return { kind: "done", output: { [node.id]: "ok" }, logs: node.id };
  };
  const store = memStore();
  const advancer = createAdvancer({
    stepRun,
    snapshot: async (id, s) => { await store.save(id, s); },
    record: async () => {},
    complete: async () => {},
    log: async () => {},
  });
  const orch = createOrchestrator(baseDeps({
    mutex: localMutex(),
    loadSpecForExec: async () => spec,
    snapshotStore: store,
    advance: async (arg) => advancer.advanceOnce(arg),
  }));
  // 1) 首轮：a、b 两个 shell 并行派发，waiting=[a,b]
  await orch.run(spec, new Map());
  // 2) a 先回（中间回调）：x=1 必须随 markDone 写入快照，供后续回调读回
  await orch.onEciDone({ execId: 1, nodeId: "a", output: "x=1" });
  assert.equal((await store.load(1)).environment.x, "1", "中间回调 a 的输出 x=1 已落库（后到回调能读到）");
  assert.ok(!rendered.c, "a 回调时 b 仍在等待 → c 依赖未满足，不应执行");
  // 3) b 后回：waiting 清空 → c 就绪，渲染 params 必须含已解析的 x=1（中间回调输出未丢）
  await orch.onEciDone({ execId: 1, nodeId: "b", output: "y=2" });
  assert.equal(
    rendered.c.sql,
    "select 1 + 2 as total",
    "下游 c 渲染后 ${x} 已替换为 1（中间回调输出未丢失，${y} 同步替换为 2）"
  );
});
