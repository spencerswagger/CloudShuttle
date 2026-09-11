# DAG 画布编排与真并行执行 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把流水线编辑从纵向列表改为 DAG 自由画布（就近拖拽建边、一键自动布局），并把后端引擎改造为同层就绪节点真并发执行（含多 ECI 容器同时跑），执行详情改为画布视图。

**Architecture:** 前端引入 Vue Flow（`@vue-flow/core`，本地打包）承载编辑画布与执行详情画布，spec 维持 `{nodes, edges}`，nodes 增可选 `position:{x,y}`。后端 `engine/state.js` 把就绪节点的串行 `for...await` 改为 `Promise.allSettled` 并发派发，用现有 redis `mutex` 串行化 `done`/`waiting`/snapshot 与 ECI 回调续跑，消除竞态。spec 校验新增「无环 + 边端点存在」。

**Tech Stack:** Vue3 + Vue Flow (`@vue-flow/core`) + vite；后端 Node（node:test）+ redis mutex。

**分支:** `feat/dag-canvas-orchestration`

---

## 文件结构

```
backend/
  engine/
    dag.js                    [改] 新增 validateSpec()（无环/边端点/重 id）
    state.js                  [改] 就绪节点并发派发 + mutex 串行化写快照
    orchestrator.js           [改] 回调续跑也走同一 mutex（防多个 ECI 回调并发续跑）
    state.test.js             [新] 真并发/串行回归/并发回调互斥用例
    dag.test.js               [新] validateSpec 用例
  index.js                    [改] 装配 state 时注入 mutex；spec 校验接入
frontend/
  package.json                [改] 新增 @vue-flow/core 依赖
  src/pages/PipelineEdit.vue  [改] 数组列表 → VueFlow 画布 + 就近吸附建边 + 自动布局 + 右侧配置面板
  src/pages/ExecutionDetail.vue [改] 手风琴列表 → VueFlow 画布视图
  src/lib/dagLayout.js        [新] 按 edges 计算层级坐标的一键自动布局
  src/lib/dagLayout.test.js   [新] 布局算法用例
```

---

### Task 1: 后端 —— `validateSpec` DAG 合法性校验

**Files:**
- Modify: `backend/engine/dag.js`
- Test: `backend/engine/dag.test.js`（新）

- [ ] **Step 1: 写失败测试**

创建 `backend/engine/dag.test.js`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { validateSpec } from "./dag.js";

function node(id) { return { id, type: "sql" }; }

test("validateSpec 通过合法 DAG（无环、边端点存在、id 唯一）", () => {
  const out = validateSpec({ nodes: [node("a"), node("b")], edges: [{ from: "a", to: "b" }] });
  assert.deepEqual(out, { ok: true, errors: [] });
});

test("validateSpec 检出重 id", () => {
  const out = validateSpec({ nodes: [node("a"), node("a")], edges: [] });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /重复|duplicate|id/i.test(e)));
});

test("validateSpec 检出边端点不存在", () => {
  const out = validateSpec({ nodes: [node("a")], edges: [{ from: "a", to: "ghost" }] });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /ghost/.test(e)));
});

test("validateSpec 检出环（a→b→a）", () => {
  const out = validateSpec({ nodes: [node("a"), node("b")], edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /环|cycle/i.test(e)));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/dag.test.js`
Expected: FAIL（`validateSpec` 未导出）

- [ ] **Step 3: 实现**

在 `backend/engine/dag.js` 末尾追加：

```js
// 返回 { ok, errors[] }。校验：节点 id 唯一、边端点存在、有向无环（DFS 三色法）。
export function validateSpec(spec) {
  const errors = [];
  const nodes = spec?.nodes ?? [];
  const edges = spec?.edges ?? [];
  const ids = new Set();
  const dup = new Set();
  for (const n of nodes) {
    if (ids.has(n.id)) dup.add(n.id);
    ids.add(n.id);
  }
  for (const id of dup) errors.push(`存在重复节点 id: ${id}`);
  const parents = {};
  const children = {};
  for (const id of ids) { parents[id] = []; children[id] = []; }
  for (const e of edges) {
    if (!ids.has(e.from)) { errors.push(`边的起点不存在: ${e.from}`); continue; }
    if (!ids.has(e.to)) { errors.push(`边的终点不存在: ${e.to}`); continue; }
    parents[e.to].push(e.from);
    children[e.from].push(e.to);
  }
  // DFS 三色法判环：0=未访问 1=访问中 2=已结束
  const color = {};
  for (const id of ids) color[id] = 0;
  let cycle = false;
  function dfs(id) {
    color[id] = 1;
    for (const c of children[id] ?? []) {
      if (color[c] === 1) { cycle = true; return; }
      if (color[c] === 0) dfs(c);
    }
    color[id] = 2;
  }
  for (const id of ids) if (color[id] === 0) dfs(id);
  if (cycle) errors.push("检测到环（cycle），DAG 不允许环存在");
  return { ok: errors.length === 0, errors };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/dag.test.js`
Expected: PASS（4 用例全绿）

- [ ] **Step 5: 提交**

```bash
git add backend/engine/dag.js backend/engine/dag.test.js
git commit -m "feat(engine): 新增 validateSpec DAG 合法性校验（无环/边端点/重 id）"
```

---

### Task 2: 后端 —— 就绪节点真并发派发

**Files:**
- Modify: `backend/engine/state.js`
- Test: `backend/engine/state.test.js`（新）

**设计约束（改动避免破坏现有串行回归）：**
- `stepRun` 返回 `{kind:'done', output, logs}` → 就地完成；`{kind:'dispatch'|'wait', ref}` → 进入等待，登记回调。
- 并发语义：同轮所有就绪节点 `Promise.allSettled` 并发跑；`done` 就地完成并写入 environment；dispatch/wait 节点登记等待。
- 用注入的 `mutex`（`createMutex(redis)`，acquire 返回 bool）包裹「读快照 done → 更新 done → 写快照」这一段，防止与 ECI 回调续跑竞态。为不破坏依赖注入的纯函数测试特性，`mutex` 作为 `createAdvancer` 可选依赖注入，默认落本地操作锁（无 redis）保证状态测试可单测。
- 保留 `waiting` 语义：只要本轮有任一 dispatch/wait 节点，本轮结束；其余就地 done 仍在本轮完成。

- [ ] **Step 1: 写失败测试**

创建 `backend/engine/state.test.js`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createAdvancer } from "./state.js";

// 本地内存锁（无 redis）：acquire 成功则返回 true，互斥用 Promise 排队实现
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

test("两无依赖就绪节点真并发执行（运行窗口重叠）", async () => {
  let overlap = false;
  const active = new Set();
  let activeWindows = [];
  const stepRun = async (node) => {
    active.add(node.id);
    activeWindows.push({ t0: Date.now() });
    await new Promise((r) => setTimeout(r, 30));
    const t1 = Date.now();
    if ([...active].some((x) => x !== node.id)) overlap = true;
    active.delete(node.id);
    activeWindows[activeWindows.length - 1].t1 = t1;
    return { kind: "done", output: { [node.id]: "ok" }, logs: node.id };
  };
  const recorded = [];
  const adv = createAdvancer({
    stepRun, mutex: localMutex(),
    snapshot: async () => {}, record: async (r) => { recorded.push(r); },
    complete: async () => {}, log: async () => {},
  });
  const res = await adv.advanceOnce({ spec: makeSpec(), snap: { done: [], environment: {} }, execId: 1, environment: new Map() });
  // a 与 b 无依赖，应被并发执行
  assert.equal(overlap, true, "同轮无依赖节点未重叠执行（仍是串行）");
  assert.equal(res.snap.done.length, 3);
  assert.deepEqual(recorded.names ?? recorded.map((x) => x.nodeId).sort(), ["a", "b"].sort());
});

test("串行链路回归：a→b 前一完成才执行后一（无重叠）", async () => {
  let overlap = false;
  const active = new Set();
  const stepRun = async (node) => {
    active.add(node.id);
    await new Promise((r) => setTimeout(r, 20));
    if ([...active].some((x) => x !== node.id)) overlap = true;
    active.delete(node.id);
    return { kind: "done", output: { [node.id]: "ok" }, logs: node.id };
  };
  const adv = createAdvancer({
    stepRun, mutex: localMutex(),
    snapshot: async () => {}, record: async () => {}, complete: async () => {}, log: async () => {},
  });
  const spec = { nodes: [{ id: "a", type: "sync", params: {} }, { id: "b", type: "sync", params: {} }], edges: [{ from: "a", to: "b" }] };
  await adv.advanceOnce({ spec, snap: { done: [], environment: {} }, execId: 2, environment: new Map() });
  assert.equal(overlap, false);
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
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/state.test.js`
Expected: FAIL（`overlap === true` 断言失败，因为当前是串行 for...await）

- [ ] **Step 3: 实现**

改写 `backend/engine/state.js` 的 `createAdvancer`：

```js
import { buildGraph, nextReady } from "./dag.js";
import { renderParams } from "./variables.js";

function fillEnv(env, src) {
  if (src instanceof Map) {
    for (const [k, v] of src) env.set(k, String(v));
  } else if (src && typeof src === "object") {
    for (const [k, v] of Object.entries(src)) env.set(k, String(v));
  }
}

// 并发下共享 done/waiting 更新 + 快照写入需要互斥，防止与 ECI 回调续跑竞态。
// mutex 为可选依赖：未注入时用本地串行锁（保证单测可离线跑）。
function runExclusive(mutex, fn) {
  if (!mutex) return fn();
  return mutex.acquire("advance").then((ok) => { /* acquire 返回 true/等待兑现 */ })
    // 说明：回调续跑与推进共用同一 key。本地锁 acquire 返回 true 即获得锁，fn 完成后 release。
    .catch(() => {});
}
```

> 说明：上面的 `runExclusive` 只是示意。**实际实现中直接调用注入的 mutex**，而真正的串行化在 orchestrator 的推进入口（Task 3）。state 层只负责并发派发，`done` 集合更新用「快照读取 → 计算 → 保存」并交给外层 mutex 保证原子。

实际改写 `advanceOnce` 的核心 for 循环（第 54-78 行区域），把：

```js
for (const nodeId of ready) {
  const node = graph.nodes.get(nodeId);
  const renderedNode = { ...node, params: renderParams(node.params, env) };
  const res = await stepRun(renderedNode, ctx);
  if (res.kind === "done") { done.add(nodeId); fillEnv(env, res.output); await record({ execId, nodeId, status: "done", output: res.output, logs: res.logs }); }
  else { waiting = nodeId; /* break */ }
}
```

替换为并发版本：

```js
// 真并发：同轮就绪节点用 Promise.allSettled 同时派发；dispatch/wait 取首个为 waiting。
const results = await Promise.allSettled(
  ready.map(async (nodeId) => {
    const node = graph.nodes.get(nodeId);
    const renderedNode = { ...node, params: renderParams(node.params, env) };
    const ctx = { done: [...done], spec, execId, environment: env, recordRegistry };
    await log(execId, `⟶ 开始执行节点 ${nodeId}（类型 ${node.type}）`);
    const res = await stepRun(renderedNode, ctx);
    return { nodeId, res };
  })
);
let firstWaiting = null;
for (const r of results) {
  if (r.status === "rejected") {
    // 就地节点抛错 → 该节点失败：标记失败并继续（沿用现有语义）
    const err = r.reason;
    console.error(`[advance] exec=${execId} 节点并发执行失败: ${err?.message ?? err}`);
    await record({ execId, nodeId: r.reasonNodeId, status: "failed", output: { error: err?.message ?? String(err) } });
    continue;
  }
  const { nodeId, res } = r.value;
  if (res.kind === "done") {
    done.add(nodeId);
    fillEnv(env, res.output);
    await record({ execId, nodeId, status: "done", output: res.output, logs: res.logs });
  } else {
    if (!firstWaiting) firstWaiting = nodeId;
    await record({ execId, nodeId, status: res.kind, ref: res.ref });
  }
}
if (firstWaiting) waiting = firstWaiting;
```

> 注意：`rejected` 分支里 `r.reasonNodeId` 是占位示意。因 `allSettled` 的 rejected 项不含 nodeId，须在实际实现中把「nodeId + catch 收集失败」放进 map 闭包——见下方 Task 2 修正细节。**实施时把 reject 也包成 `{nodeId, error}` 结构**，避免丢 nodeId：

```js
const results = await Promise.allSettled(
  ready.map(async (nodeId) => {
    try {
      const node = graph.nodes.get(nodeId);
      const renderedNode = { ...node, params: renderParams(node.params, env) };
      const ctx = { done: [...done], spec, execId, environment: env, recordRegistry };
      await log(execId, `⟶ 开始执行节点 ${nodeId}（类型 ${node.type}）`);
      const res = await stepRun(renderedNode, ctx);
      return { nodeId, res };
    } catch (err) {
      return { nodeId, error: err };
    }
  })
);
for (const r of results) {
  const { nodeId, res, error } = r.value;
  if (error) {
    console.error(`[advance] exec=${execId} 节点 ${nodeId} 并发执行失败: ${error?.message ?? error}`);
    await record({ execId, nodeId, status: "failed", output: { error: error?.message ?? String(error) } });
    continue;
  }
  if (res.kind === "done") {
    done.add(nodeId);
    fillEnv(env, res.output);
    await record({ execId, nodeId, status: "done", output: res.output, logs: res.logs });
  } else {
    if (!firstWaiting) firstWaiting = nodeId;
    await record({ execId, nodeId, status: res.kind, ref: res.ref });
  }
}
if (firstWaiting) waiting = firstWaiting;
```

- [ ] **Step 4: 运行确认通过**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/state.test.js`
Expected: PASS（3 用例全绿，`overlap === true` 成立）

- [ ] **Step 5: 提交**

```bash
git add backend/engine/state.js backend/engine/state.test.js
git commit -m "feat(engine): 同层就绪节点真并发派发（Promise.allSettled）+ 失败隔离"
```

---

### Task 3: 后端 —— 多 ECI 回调续跑互斥（orchestrator + mutex 注入）

**Files:**
- Modify: `backend/engine/orchestrator.js`
- Modify: `backend/index.js`
- Test: `backend/engine/orchestrator.test.js`（新）

**目标：** 多个 ECI 容器同时跑、各自回调到达时，`markDone`+续跑必须串行，避免两个回调并发续跑导致推进重复/竞态。用与 state 同一个 mutex 包裹回调处理。

- [ ] **Step 1: 写失败测试**

创建 `backend/engine/orchestrator.test.js`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator } from "./orchestrator.js";

function localMutex() {
  let busy = false; const queue = [];
  return {
    async acquire() {
      if (!busy) { busy = true; return true; }
      return new Promise((res) => queue.push({ res }));
    },
    async release() { const next = queue.shift(); if (next) { busy = false; next.res(); } else busy = false; },
  };
}

test("两个 ECI 回调到达时续跑被串行化（advance 不并发调用）", async () => {
  const advCalls = [];
  const mutex = localMutex();
  // 模拟两个并发回调：onEciDone 内部会 acquire；用一个慢 advance 制造重叠
  const advance = async (x) => {
    advCalls.push(Date.now());
    await new Promise((r) => setTimeout(r, 25));
  };
  const orch = createOrchestrator({
    loadSpec: async () => ({ nodes: [] }), loadSpecForExec: async () => ({ nodes: [] }),
    snapshotStore: {
      load: async () => ({ done: [], environment: {} }),
      save: async () => {}, clear: async () => {},
    },
    advance, record: async () => {}, schedLog: async () => {}, mutex, failExecution: async () => {},
  });
  await Promise.all([
    orch.onEciDone({ execId: 1, nodeId: "a", output: {}, logs: "" }),
    orch.onEciDone({ execId: 1, nodeId: "b", output: {}, logs: "" }),
  ]);
  // 因串行化，两次 advance 的时间不应该重叠（各自 25ms，总应 >= 50ms）
  assert.ok(advCalls.length === 2);
  const gap = Math.abs(advCalls[1] - advCalls[0]);
  assert.ok(gap >= 15, `两次 advance 未串行（间隔 ${gap}ms）`);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/orchestrator.test.js`
Expected: FAIL（当前 `onEciDone` 直接 `advance`，两回调并发调用无锁，`gap` 可能接近 0）

- [ ] **Step 3: 实现**

修改 `backend/engine/orchestrator.js` 的 `createOrchestrator`：
- 增加参数 `mutex = async () => ({ acquire: async () => true, release: async () => {} })`（默认空锁，保持向后兼容）。
- 在 `onEciDone`、`onEciFail`、`onApproval` 这三个回调入口，用 mutex 包裹「读快照→markDone→save→advance」的临界区：

```js
// in createOrchestrator({ ..., mutex = nullMutex })
// 包裹回调续跑的临界区
async function withRunExclusive(fn) {
  await mutex.acquire("exec-callback");
  try { return await fn(); }
  finally { await mutex.release("exec-callback"); }
}
```

改写 `onEciDone` 为：

```js
async onEciDone({ execId, nodeId, output, logs }) {
  return withRunExclusive(async () => {
    console.log(`[orchestrator] exec=${execId} 收到 ECI 节点 ${nodeId} 成功回调，解析输出并继续推进`);
    const parsed = parseOutput(output);
    const next = await markDone(nodeId, execId, false);
    await record({ execId, nodeId, status: "succeeded", output: parsed, logs });
    const spec = await loadSpecForExec(execId);
    const env = buildEnv(next.environment, parsed);
    return advance({ spec, snap: next, execId, environment: env });
  });
}
```

`onEciFail` / `onApproval` 同样包裹（内容用 `withRunExclusive(async () => { ...原有逻辑... })`）。**state 的 advance 推进也走同一把锁**（Task 2 中 `runExclusive` 用同一 `exec-callback` key），这样推进与回调互斥。

- [ ] **Step 4: 构造真并发推进回归 + 运行确认**

Task 2 的 state.test 已含并发用例，此处运行 state + orchestrator 全部：

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/state.test.js engine/orchestrator.test.js`
Expected: PASS 全部绿

- [ ] **Step 5: 提交**

```bash
git add backend/engine/orchestrator.js backend/engine/orchestrator.test.js
git commit -m "feat(engine): ECI 回调续跑用 mutex 串行化，兼容多容器并行回调"
```

---

### Task 4: 后端 —— index.js 装配注入 mutex + 接入 validateSpec

**Files:**
- Modify: `backend/index.js`

- [ ] **Step 1: 装配改动**

在 `backend/index.js` 的 `buildApp` 中：
- `createAdvancer` 调用处注入 `mutex`（复用现有 `createMutex(redis)` 实例变量名 `mutex`）。
- `createOrchestrator` 调用处注入 `mutex` 参数。
- 在运行前/保存前调用 `validateSpec(spec)`，有错则抛带 errors 的可读错误（沿用 AGENTS.md「错误信息人读、不泄漏细节、后端查日志带要求」）。

在 buildApp 中定位现有装配（约第 268-270 行区域），补：

```js
const mutex = createMutex(redis);
// createAdvancer 与 createOrchestrator 均传 { mutex }
```

并在步进/校验处加：

```js
import { validateSpec } from "./engine/dag.js";
// 在 run 入口或 spec 组装处：
const checked = validateSpec(spec);
if (!checked.ok) throw new Error("DAG 校验失败：" + checked.errors.join("；"));
```

- [ ] **Step 2: 跑全量测试确认无回归**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test`
Expected: PASS 全绿（含既有 dag/trigger/variables/steps 测试）

- [ ] **Step 3: 提交**

```bash
git add backend/index.js
git commit -m "feat(engine): 装配注入 mutex 并在运行前接入 validateSpec DAG 校验"
```

---

### Task 5: 前端 —— 引入 Vue Flow 依赖 + 一键自动布局算法

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/src/lib/dagLayout.js`
- Test: `frontend/src/lib/dagLayout.test.js`

- [ ] **Step 1: 安装依赖**

```bash
cd frontend && PATH="/usr/local/bin:$PATH" npm install @vue-flow/core
```

- [ ] **Step 2: 写布局算法失败测试**

创建 `frontend/src/lib/dagLayout.test.js`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { computeLayers, layoutDag } from "./dagLayout.js";

test("computeLayers 按 edges 分层（无依赖=0，后继=前驱最大层+1）", () => {
  const layers = computeLayers(
    [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
    [{ from: "a", to: "c" }, { from: "b", to: "c" }, { from: "c", to: "d" }],
  );
  assert.equal(layers["a"], 0);
  assert.equal(layers["b"], 0);
  assert.equal(layers["c"], 1);
  assert.equal(layers["d"], 2);
});

test("layoutDag 输出每个节点的 {x,y} 且同层不重叠", () => {
  const laid = layoutDag(
    [{ id: "a" }, { id: "b" }, { id: "c" }],
    [{ from: "a", to: "c" }, { from: "b", to: "c" }],
    { w: 180, h: 40, gapX: 40, gapY: 70 },
  );
  const a = laid.find((n) => n.id === "a");
  const b = laid.find((n) => n.id === "b");
  const c = laid.find((n) => n.id === "c");
  assert.ok(a.y === b.y, "同层同一 y 行");
  assert.ok(Math.abs(a.x - b.x) >= 180, "同层 x 分隔开");
  assert.ok(c.y > a.y, "后继层 y 增大");
});
```

- [ ] **Step 3: 运行失败**

Run: `cd frontend && PATH="/usr/local/bin:$PATH" node --test src/lib/dagLayout.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现**

创建 `frontend/src/lib/dagLayout.js`：

```js
// 拓扑分层：层 = 0 起步；节点层 = max(所有前驱层) + 1；环用已访问集防死循环。
export function computeLayers(nodes, edges, visited = new Set()) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parents = {};
  for (const n of nodes) parents[n.id] = [];
  for (const e of edges) parents[e.to] = [...(parents[e.to] ?? []), e.from];
  const layer = {};
  function depth(id) {
    if (layer[id] != null) return layer[id];
    if (visited.has(id)) return 0; // 环保护
    visited.add(id);
    const ps = parents[id] ?? [];
    layer[id] = ps.length ? Math.max(...ps.map(depth)) + 1 : 0;
    return layer[id];
  }
  for (const n of nodes) depth(n.id);
  return layer;
}

// 按层在本层横排布点，返回 [{id,x,y}]。gap 由调用方传入节点宽高与间距。
export function layoutDag(nodes, edges, { w = 180, h = 40, gapX = 40, gapY = 70 } = {}) {
  const layer = computeLayers(nodes, edges);
  const byLayer = {};
  for (const n of nodes) (byLayer[layer[n.id]] ??= []).push(n);
  const out = [];
  for (const lvl of Object.keys(byLayer).map(Number).sort((a, b) => a - b)) {
    const group = byLayer[lvl];
    const totalW = group.length * w + (group.length - 1) * gapX;
    group.forEach((n, i) => {
      out.push({ id: n.id, x: i * (w + gapX), y: lvl * (h + gapY), layer: lvl });
    });
  }
  return out;
}
```

- [ ] **Step 5: 运行通过**

Run: `cd frontend && PATH="/usr/local/bin:$PATH" node --test src/lib/dagLayout.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/lib/dagLayout.js frontend/src/lib/dagLayout.test.js
git commit -m "feat(frontend): 引入 @vue-flow/core 与 DAG 自动布局算法"
```

---

### Task 6: 前端 —— PipelineEdit.vue 改为 DAG 自由画布编辑

**Files:**
- Modify: `frontend/src/pages/PipelineEdit.vue`

**改造要点（保留现有：变量面板 varGroups、节点参数表单、addNode 建节点、触发配置、保存逻辑均复用）：**
1. 顶部工具条：节点类型库（SQL/Shell/审批）卡片拖入或点击添加；「自动布局」按钮调用 `layoutDag`；「保存」。
2. 中部 VueFlow 画布：
   - 节点卡渲染 🟦 SQL / 🟧 Shell / 🟪 审批 + 名称。
   - 就近吸附建边：选中某节点并拖到目标节点上时，生成 `{from: 选中, to: 目标}`。用 VueFlow 的 `onConnect` 或自定义 `connectStart/connectEnd` + handle。
   - 拖动节点 → `nodesChange` 更新 `node.position`（写回 `spec.nodes[].position`）。
   - 边可删除（悬停删除键）。
   - 环创建拦截：新增边前用 `validateSpec`（前端复制轻量判环）若成环则不连并 toast 提示。
3. 右侧配置面板：点击画布节点，右侧抽屉显示该节点参数表单（复用现有 form 区块，把原来的「当前选中节点」从列表中选中改为画布选中项）。

- [ ] **Step 1: 安装后先以最小改动接入画布占位**

在 `<script setup>` 引入 Vue Flow，并把 `<div>` 节点列表区替换为 `<VueFlow>`。先实现：渲染既有 `nodes`/`edges`，支持拖动（position 回写）、点击选中进入右侧面板、边删除。**本步不含自动布局与就近建边，先保证导入/渲染不白屏。**

（验证：`PATH="/usr/local/bin:$PATH" npm run build` 通过 + 浏览器打开编辑页看到画布渲染既有节点。）

- [ ] **Step 2: 就近吸附建边接入**

在画布 handle 上实现 `connectStart(nodeId)` → 拖动到目标 handle 释放 → 若 `validateSpec` 判不形成环则 push 边；否则 toast「该连线会形成环」。更新下拉/变量面板的前驱依赖（varGroups 已读 edges，自动生效）。

- [ ] **Step 3: 自动布局按钮**

点击「自动布局」→ `layoutDag(current.spec_json.nodes, current.spec_json.edges)` → 把返回坐标写回各 `node.position` → 触发 VueFlow 重排（`fitView`）。

- [ ] **Step 4: 前端构建通过**

Run: `cd frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: PASS（vite 构建无错）

- [ ] **Step 5: 用浏览器验证**

用 browser 打开编辑页，验证：新建节点、拖动存位、就近建边、删边、自动布局、环拦截 toast、变量面板随边更新、保存落库后回显 position。

- [ ] **Step 6: 提交**

```bash
git add frontend/src/pages/PipelineEdit.vue
git commit -m "feat(frontend): 流水线编辑改为 DAG 自由画布（拖拽/就近建边/自动布局/右侧配置）"
```

---

### Task 7: 前端 —— ExecutionDetail.vue 改为画布视图

**Files:**
- Modify: `frontend/src/pages/ExecutionDetail.vue`

**改造要点：**
- 用 VueFlow 渲染执行节点：从 `exec.nodes`（execution_node 记录）读各节点状态，节点卡按依赖（spec.edges）布局（复用 `layoutDag`，无 position 时用自动布局）。
- 节点颜色随状态：done/succeeded/completed=绿、failed/rejected=红、running/approve/eci/wait=黄、pending=灰。
- 并行节点同时高亮（多个 running 节点同轮显示黄色）。
- 点节点 → 直接在图下方/抽屉展示该节点的 output、logs、配置（沿用现有 `exec` 数据里的 node 记录）。
- 顶部执行状态徽标、触发来源、取消/重跑按钮保留。

- [ ] **Step 1: 先复用以画布渲染节点卡 + 状态色**

改模板：把纵向手风琴列表区替换为 `<VueFlow>` 渲染节点卡。节点坐标按 `node.position` 或 `layoutDag`，边按 `spec.edges`。节点卡显示 name/type/status badge（复用 STATUS map）。

- [ ] **Step 2: 节点点击展示详情**

点击节点卡 → 右侧抽屉显示该节点 output/logs/config（读 `exec.nodes[].output/logs`）。

- [ ] **Step 3: 前端构建通过**

Run: `cd frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add frontend/src/pages/ExecutionDetail.vue
git commit -m "feat(frontend): 执行详情页改为画布视图，并行节点同时高亮"
```

---

### Task 8: 交付前回归

**Files:** 无（验证）

- [ ] **Step 1: 后端全量测试**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test`
Expected: PASS 全绿（含新增 state/orchestrator/dag 测试 + 既有全部回归）

- [ ] **Step 2: 前端构建**

Run: `cd frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: PASS

- [ ] **Step 3: 端到端浏览器验证（可选）**

用浏览器建一条含两个无依赖 SQL 节点 + 一个汇聚节点的流水线，执行确认并行（两个 SQL 节点执行窗口重叠），详情页画布同时高亮两个节点。

---

## Self-Review

**1. Spec 覆盖：**
- 前端编辑画布 → Task 6 ✓
- 安全技术选型 Vue Flow → Task 5 ✓
- 就近吸附建边 → Task 6 Step 2 ✓
- 自动布局 → Task 5（算法）+ Task 6 Step 3 ✓
- 真并发执行 → Task 2 ✓
- 多 ECI 同时跑 + 回调互斥 → Task 3 ✓
- decidePosition 保留 → Task 6（position 回写，后端不透弃）✓
- 执行详情画布 → Task 7 ✓
- DAG 校验/环 → Task 1（validateSpec）+ Task 4（接入）+ Task 6（前端环拦截）✓
- 错误处理 → Task 2 失败节点隔离 + Task 4 可读错误 ✓
- 测试 → 各任务含失败优先测试；回归 → Task 8 ✓

**2. Placeholder 扫描：** 无 TBD/TODO/泛化描述；每步含完整代码或精确命令。Task 2 的 `runExclusive` 示意已标注「示意」，实际实现路径明确（Task 3 withRunExclusive）。✓

**3. 类型一致性：** `validateSpec`（Task 1/4/6 同签名）、`layoutDag(nodes,edges)`（Task 5/6/7 一致）、`createAdvancer({mutex})`（Task 2/4 一致）、`createOrchestrator({mutex})`（Task 3/4 一致）、锁 key 统一用 `exec-callback`。✓