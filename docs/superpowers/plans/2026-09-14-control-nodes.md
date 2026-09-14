# 控制节点（branch / join / loop）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为工作流引擎新增三类控制节点——branch（边条件分支）、join（汇聚）、loop（loop→join 子图循环），含引擎推进语义、画布交互与执行详情展示。

**Architecture:** 保持 FC「短请求、一次唤醒推进」与回调续跑机制不变，控制语义落在引擎推进层：branch/join/loop 的 step 均为 `{kind:"done", output:{}}` 纯标记；`state.js` 承担边条件求值（JSONPath+比较符）、dead/skipped 传播与 loop 迭代状态机；`orchestrator.js` 新增 drain 循环（同步节点一次唤醒内连续推进）并让 `markDone` 透传快照其余字段；快照（Redis）扩展 `trigger_raw / node_outputs / loops / skipped` 四字段，无 PG schema 改动。

**Tech Stack:** Node.js（node:test 单测）、jsonpath-plus（已有依赖）、Vue 3 + VueFlow。

参考规格：`docs/superpowers/specs/2026-09-14-control-nodes-design.md`。测试命令：后端 `cd backend && PATH="/usr/local/bin:$PATH" node --test`；前端 `cd frontend && PATH="/usr/local/bin:$PATH" npm run build`。

---

### Task 1: 控制节点 step 三件套（branch/join/loop）与 STEP_TYPES 注册

**Files:**
- Create: `backend/steps/branch.js`
- Create: `backend/steps/branch.test.js`
- Create: `backend/steps/join.js`
- Create: `backend/steps/join.test.js`
- Create: `backend/steps/loop.js`
- Create: `backend/steps/loop.test.js`
- Modify: `backend/index.js`（imports、`STEP_TYPES`、`buildApp().steps` 装配）

- [ ] **Step 1: 写三个 step 的失败测试**

`backend/steps/branch.test.js`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { makeBranchStep } from "./branch.js";

test("branch step 返回 done 且输出为空（边条件求值由引擎推进层完成）", async () => {
  const step = makeBranchStep();
  const res = await step({ id: "b1", type: "branch", params: {} }, { environment: new Map() });
  assert.deepEqual(res, { kind: "done", output: {} });
});

test("branch step 与节点参数无关（no-op 标记节点）", async () => {
  const step = makeBranchStep();
  const res = await step({ id: "b2", type: "branch", params: { anything: 1 } }, { environment: new Map() });
  assert.equal(res.kind, "done");
  assert.deepEqual(res.output, {});
});
```

`backend/steps/join.test.js`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { makeJoinStep } from "./join.js";

test("join step 返回 done 且输出为空（汇聚由 DAG 依赖自然收敛）", async () => {
  const step = makeJoinStep();
  const res = await step({ id: "j1", type: "join", params: {} }, { environment: new Map() });
  assert.deepEqual(res, { kind: "done", output: {} });
});

test("join step 与节点参数无关（no-op 标记节点）", async () => {
  const step = makeJoinStep();
  const res = await step({ id: "j2", type: "join", params: { anything: 1 } }, { environment: new Map() });
  assert.equal(res.kind, "done");
  assert.deepEqual(res.output, {});
});
```

`backend/steps/loop.test.js`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { makeLoopStep } from "./loop.js";

test("loop step 返回 done 且输出为空（迭代推进由引擎状态机完成）", async () => {
  const step = makeLoopStep();
  const res = await step({ id: "l1", type: "loop", params: { items: { count: 3 } } }, { environment: new Map() });
  assert.deepEqual(res, { kind: "done", output: {} });
});

test("loop step 与节点参数无关（no-op 标记节点）", async () => {
  const step = makeLoopStep();
  const res = await step({ id: "l2", type: "loop", params: {} }, { environment: new Map() });
  assert.equal(res.kind, "done");
  assert.deepEqual(res.output, {});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test steps/branch.test.js steps/join.test.js steps/loop.test.js`
Expected: FAIL——`Cannot find module './branch.js'`（或 import 报错）。

- [ ] **Step 3: 实现三个 step**

`backend/steps/branch.js`：

```js
// branch 条件分支节点：出边条件求值与 dead 传播由引擎推进层（state.js）完成，
// 节点本身无副作用、无输出，仅作为分支起点标记。
export function makeBranchStep() {
  return async function branchStep() {
    return { kind: "done", output: {} };
  };
}
```

`backend/steps/join.js`：

```js
// join 汇聚节点：等待全部前驱完成（含被跳过的 skipped 节点）后放行，
// 语义由 DAG 依赖 + state.js 的 skipped 传播自然实现，节点本身 no-op。
export function makeJoinStep() {
  return async function joinStep() {
    return { kind: "done", output: {} };
  };
}
```

`backend/steps/loop.js`：

```js
// loop 循环入口节点：迭代推进由引擎推进层（state.js）状态机完成，
// 节点本身 no-op，仅在循环结束时由引擎补记累积输出。
export function makeLoopStep() {
  return async function loopStep() {
    return { kind: "done", output: {} };
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test steps/branch.test.js steps/join.test.js steps/loop.test.js`
Expected: PASS（3 个测试文件全绿）。

- [ ] **Step 5: 注册 STEP_TYPES 并在 buildApp 装配**

修改 `backend/index.js`：
- 在既有步骤 import 旁（第 20 行 `makeTriggerStep` 之后）加三行 import：

```js
import { makeBranchStep } from "./steps/branch.js";
import { makeJoinStep } from "./steps/join.js";
import { makeLoopStep } from "./steps/loop.js";
```

- `STEP_TYPES`（第 267 行）改为：

```js
export const STEP_TYPES = ["trigger", "shell", "approval", "sql", "branch", "join", "loop"];
```

- `buildApp().steps`（第 347-358 行）在 `sql` 后追加：

```js
    branch: makeBranchStep(),
    join: makeJoinStep(),
    loop: makeLoopStep(),
```

（`buildApp` 内已有的「steps 实现集合必须与 STEP_TYPES 一致」防漂移循环会自动校验，无需额外处理。）

- [ ] **Step 6: 全量后端测试回归**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test`
Expected: 全部 PASS（含既有用例，STEP_TYPES 三处同步无漂移报错）。

- [ ] **Step 7: Commit**

```bash
git add backend/steps/branch.js backend/steps/branch.test.js backend/steps/join.js backend/steps/join.test.js backend/steps/loop.js backend/steps/loop.test.js backend/index.js
git commit -m "feat: 新增 branch/join/loop 控制节点 step 并注册 STEP_TYPES"
```

---

### Task 2: 条件求值模块 conditions.js

**Files:**
- Create: `backend/engine/conditions.js`
- Create: `backend/engine/conditions.test.js`

- [ ] **Step 1: 写失败测试**

`backend/engine/conditions.test.js`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { evalCond, buildCondCtx, COND_OPS } from "./conditions.js";

const ctx = buildCondCtx({
  triggerRaw: { branch: "release", count: 3, tags: ["v1", "v2"], note: "" },
  nodeOutputs: { shell1: { sha: "abc123", rows: 5 } },
  env: { pipeline_name: "demo" },
});

test("COND_OPS 白名单齐全", () => {
  assert.deepEqual(COND_OPS, ["eq", "ne", "gt", "ge", "lt", "le", "contains", "starts_with", "ends_with", "exists", "empty", "regex"]);
});

test("eq / ne 对字符串与数字", () => {
  assert.equal(evalCond({ path: "$.trigger.branch", op: "eq", val: "release" }, ctx), true);
  assert.equal(evalCond({ path: "$.trigger.branch", op: "ne", val: "dev" }, ctx), true);
  assert.equal(evalCond({ path: "$.trigger.count", op: "eq", val: 3 }, ctx), true);
});

test("gt / ge / lt / le 数值比较（字符串值也能转数字）", () => {
  assert.equal(evalCond({ path: "$.outputs.shell1.rows", op: "gt", val: 3 }, ctx), true);
  assert.equal(evalCond({ path: "$.trigger.count", op: "ge", val: 3 }, ctx), true);
  assert.equal(evalCond({ path: "$.outputs.shell1.rows", op: "lt", val: 10 }, ctx), true);
  assert.equal(evalCond({ path: "$.trigger.count", op: "le", val: 2 }, ctx), false);
});

test("contains / starts_with / ends_with", () => {
  assert.equal(evalCond({ path: "$.trigger.branch", op: "contains", val: "ease" }, ctx), true);
  assert.equal(evalCond({ path: "$.trigger.branch", op: "starts_with", val: "rel" }, ctx), true);
  assert.equal(evalCond({ path: "$.trigger.branch", op: "ends_with", val: "ase" }, ctx), true);
});

test("exists / empty（数组与非空串）", () => {
  assert.equal(evalCond({ path: "$.trigger.note", op: "exists" }, ctx), true);
  assert.equal(evalCond({ path: "$.trigger.note", op: "empty" }, ctx), true);
  assert.equal(evalCond({ path: "$.trigger.branch", op: "empty" }, ctx), false);
  assert.equal(evalCond({ path: "$.trigger.missing", op: "exists" }, ctx), false);
  assert.equal(evalCond({ path: "$.trigger.missing", op: "empty" }, ctx), true);
});

test("regex 命中与非法正则", () => {
  assert.equal(evalCond({ path: "$.outputs.shell1.sha", op: "regex", val: "^abc" }, ctx), true);
  assert.equal(evalCond({ path: "$.outputs.shell1.sha", op: "regex", val: "(" }, ctx), false);
});

test("JSONPath 命中数组时取首元素（wrap:false 语义对齐 trigger.js）", () => {
  assert.equal(evalCond({ path: "$.trigger.tags", op: "eq", val: "v1" }, ctx), true);
});

test("非法条件（缺 path / op 不在白名单）恒 false", () => {
  assert.equal(evalCond({ path: "", op: "eq", val: "x" }, ctx), false);
  assert.equal(evalCond({ path: "$.trigger.branch", op: "like", val: "x" }, ctx), false);
  assert.equal(evalCond(null, ctx), false);
});

test("JSONPath 异常静默 false（不抛错）", () => {
  assert.equal(evalCond({ path: "$..[", op: "eq", val: "x" }, ctx), false);
});

test("buildCondCtx 缺省字段给 null/空对象，不抛错", () => {
  const c = buildCondCtx({});
  assert.deepEqual(c, { trigger: null, outputs: {}, env: {} });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/conditions.test.js`
Expected: FAIL——`Cannot find module './conditions.js'`。

- [ ] **Step 3: 实现 conditions.js**

`backend/engine/conditions.js`：

```js
// 边条件求值：JSONPath 从条件上下文树取值 + 比较运算符。
// 条件上下文树：{ trigger, outputs, env }，供 branch 出边条件与 loop items 取数共用。
import { JSONPath } from "jsonpath-plus";

const OPS = {
  eq: (a, b) => a == b,
  ne: (a, b) => a != b,
  gt: (a, b) => Number(a) > Number(b),
  ge: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  le: (a, b) => Number(a) <= Number(b),
  contains: (a, b) => String(a ?? "").includes(String(b)),
  starts_with: (a, b) => String(a ?? "").startsWith(String(b)),
  ends_with: (a, b) => String(a ?? "").endsWith(String(b)),
  exists: (a) => a !== undefined && a !== null,
  empty: (a) => a === undefined || a === null || a === "" || (Array.isArray(a) && a.length === 0),
  regex: (a, b) => {
    try { return new RegExp(String(b)).test(String(a ?? "")); }
    catch { return false; }
  },
};

export const COND_OPS = Object.keys(OPS);

/**
 * 对条件上下文树求值一条边条件。任何异常/非法输入一律返回 false，绝不抛错。
 * @param {{path?:string, op?:string, val?:*} | null | undefined} cond
 * @param {object} ctx 条件上下文树（buildCondCtx 产物）
 * @returns {boolean}
 */
export function evalCond(cond, ctx) {
  if (!cond || typeof cond !== "object") return false;
  const { path, op, val } = cond;
  if (typeof path !== "string" || !path.trim() || !Object.hasOwn(OPS, op)) return false;
  let hit;
  try { hit = JSONPath({ path, json: ctx, wrap: false }); }
  catch { return false; }
  // wrap:false 命中数组时多余的容器外层返回数组，取首元素（与 trigger.js 的 hitJsonPath 对齐）
  if (Array.isArray(hit)) hit = hit[0];
  return OPS[op](hit, val);
}

/**
 * 构造条件上下文树。
 * @param {{triggerRaw?: unknown, nodeOutputs?: Record<string, object>, env?: Record<string, string>}} parts
 * @returns {{trigger: unknown, outputs: Record<string, object>, env: Record<string, string>}}
 */
export function buildCondCtx({ triggerRaw, nodeOutputs, env } = {}) {
  return { trigger: triggerRaw ?? null, outputs: nodeOutputs ?? {}, env: env ?? {} };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/conditions.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/engine/conditions.js backend/engine/conditions.test.js
git commit -m "feat: 边条件求值模块（JSONPath + 比较运算符白名单）"
```

---

### Task 3: dag.js 校验扩展与 loop 区域计算

**Files:**
- Modify: `backend/engine/dag.js`
- Modify: `backend/engine/dag.test.js`

- [ ] **Step 1: 写失败测试**

在 `backend/engine/dag.test.js` 末尾追加（沿用文件里已有的 `node(id)` 辅助；**先把第 5 行的辅助改为支持类型参数**，既有用例不受影响）：

```js
function node(id, type = "sql") { return { id, type }; }
```

并把第 3 行的 import 改为同时引入 `loopRegionOf`：

```js
import { validateSpec, loopRegionOf } from "./dag.js";
```

```js
test("validateSpec 校验边条件格式（path 缺失 / op 非法）", () => {
  const bad1 = validateSpec({ nodes: [node("a"), node("b")], edges: [{ from: "a", to: "b", cond: { path: "", op: "eq", val: "x" } }] });
  assert.ok(bad1.errors.some((e) => e.includes("条件缺少 path")));
  const bad2 = validateSpec({ nodes: [node("a"), node("b")], edges: [{ from: "a", to: "b", cond: { path: "$.x", op: "like", val: "x" } }] });
  assert.ok(bad2.errors.some((e) => e.includes("op 非法")));
  // 合法条件与无条件边：不产生条件类错误，整体 ok
  const good = validateSpec({
    nodes: [node("a"), node("b"), node("c")],
    edges: [{ from: "a", to: "b", cond: { path: "$.x", op: "eq", val: "y" } }, { from: "b", to: "c" }],
  });
  assert.equal(good.ok, true);
});

test("loopRegionOf 正常区域：body 含普通节点，返回 bodyIds 与 joinId", () => {
  const nodes = [node("l", "loop"), node("s", "shell"), node("j", "join")];
  const edges = [{ from: "l", to: "s" }, { from: "s", to: "j" }];
  const out = loopRegionOf({ nodes, edges, loopId: "l" });
  assert.deepEqual(out.bodyIds, ["s"]);
  assert.equal(out.joinId, "j");
  assert.equal(out.err, undefined);
});

test("loopRegionOf 拒绝：循环体内嵌套控制节点", () => {
  const nodes = [node("l", "loop"), node("b", "branch"), node("j", "join")];
  const edges = [{ from: "l", to: "b" }, { from: "b", to: "j" }];
  const out = loopRegionOf({ nodes, edges, loopId: "l" });
  assert.ok(out.err.includes("不允许 branch"));
});

test("loopRegionOf 拒绝：loop 出边直连 join（循环体为空）", () => {
  const nodes = [node("l", "loop"), node("j", "join")];
  const edges = [{ from: "l", to: "j" }];
  const out = loopRegionOf({ nodes, edges, loopId: "l" });
  assert.ok(out.err.includes("循环体至少 1 个节点"));
});

test("loopRegionOf 拒绝：缺少 join / join 入边来自区域外", () => {
  const noJoin = loopRegionOf({ nodes: [node("l", "loop"), node("s", "shell")], edges: [{ from: "l", to: "s" }], loopId: "l" });
  assert.ok(noJoin.err.includes("缺少收敛的 join"));
  const nodes = [node("l", "loop"), node("s", "shell"), node("j", "join"), node("x", "shell")];
  const edges = [{ from: "l", to: "s" }, { from: "s", to: "j" }, { from: "x", to: "j" }];
  const out = loopRegionOf({ nodes, edges, loopId: "l" });
  assert.ok(out.err.includes("循环体外节点 x"));
});

test("validateSpec 校验 loop 区域约束（体内嵌套 / 缺 join）", () => {
  const nodes = [node("l", "loop"), node("b", "branch"), node("j", "join")];
  const edges = [{ from: "l", to: "b" }, { from: "b", to: "j" }];
  const out = validateSpec({ nodes, edges });
  assert.ok(out.errors.some((e) => e.includes("循环体内不允许 branch")));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/dag.test.js`
Expected: FAIL——`loopRegionOf is not defined`（及校验规则未实现）。

- [ ] **Step 3: 实现**

修改 `backend/engine/dag.js`：
- 顶部加 import：

```js
import { COND_OPS } from "./conditions.js";
```

- 文件末尾追加 `loopRegionOf` 导出，并在 `validateSpec` 内加两条校验块。

`loopRegionOf`（完整代码）：

```js
// 计算 loop 循环区域：loopId → { bodyIds, joinId }（或 { err }）。
// 区域 = loop 可达、首个 join 之前的全部节点；仅支持单一收敛 join。
// 循环体内不允许 trigger/branch/join/loop（仅普通节点）。
export function loopRegionOf({ nodes, edges, loopId }) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const succ = {}; const pred = {};
  for (const n of nodes) { succ[n.id] = []; pred[n.id] = []; }
  for (const e of edges) { succ[e.from].push(e.to); pred[e.to].push(e.from); }
  const seen = new Set();
  const joins = [];
  const stack = [...(succ[loopId] ?? [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    if (byId.get(id)?.type === "join") { joins.push(id); continue; } // 不穿过 join
    for (const c of succ[id] ?? []) stack.push(c);
  }
  if (joins.length === 0) return { err: `loop 节点 ${loopId} 缺少收敛的 join 节点` };
  if (joins.length > 1) return { err: `loop 节点 ${loopId} 区域存在多个 join 节点（${joins.join(",")}），仅支持单一收敛` };
  const joinId = joins[0];
  const bodyIds = [...seen].filter((id) => id !== joinId);
  if (!bodyIds.length) return { err: `loop 节点 ${loopId} 出边不能直连 join，循环体至少 1 个节点` };
  const FORBIDDEN = new Set(["trigger", "branch", "join", "loop"]);
  for (const id of bodyIds) {
    const t = byId.get(id)?.type;
    if (FORBIDDEN.has(t)) return { err: `loop 节点 ${loopId} 循环体内不允许 ${t} 节点（${id}）` };
  }
  for (const p of pred[joinId] ?? []) {
    if (!bodyIds.includes(p)) return { err: `join 节点 ${joinId} 的入边来自循环体外节点 ${p}` };
  }
  for (const c of succ[loopId] ?? []) {
    if (!bodyIds.includes(c)) return { err: `loop 节点 ${loopId} 的出边指向循环体外节点 ${c}` };
  }
  for (const id of bodyIds) {
    for (const c of succ[id] ?? []) {
      if (c !== joinId && !bodyIds.includes(c)) return { err: `loop 节点 ${loopId} 循环体节点 ${id} 的出边离开循环区域（${c}）` };
    }
  }
  return { bodyIds, joinId };
}
```

`validateSpec` 内在边端点校验之后、环检测之前插入（注意用 `errors.push`）：

```js
  // 边条件格式（branch 出边 cond）
  for (const e of edges) {
    if (!e.cond) continue;
    if (typeof e.cond.path !== "string" || !e.cond.path.trim()) {
      errors.push(`边 ${e.from}→${e.to} 条件缺少 path`);
    } else if (!COND_OPS.includes(e.cond.op)) {
      errors.push(`边 ${e.from}→${e.to} 条件 op 非法: ${e.cond.op}`);
    }
  }
  // loop 区域约束
  for (const n of nodes) {
    if (n.type !== "loop") continue;
    const { err } = loopRegionOf({ nodes, edges, loopId: n.id });
    if (err) errors.push(err);
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/dag.test.js`
Expected: PASS（新用例全绿，旧用例不回归——注意既有「环检测」用例不受影响）。

- [ ] **Step 5: Commit**

```bash
git add backend/engine/dag.js backend/engine/dag.test.js
git commit -m "feat: DAG 校验支持边条件格式与 loop 循环区域约束"
```

---

### Task 4: state.js 快照扩展与 branch 剪枝（dead/skipped 传播）

**Files:**
- Modify: `backend/engine/state.js`
- Modify: `backend/engine/state.test.js`

- [ ] **Step 1: 写失败测试**

在 `backend/engine/state.test.js` 末尾追加（沿用文件既有 `createAdvancer` 注入模式；参考文件头部 `makeSpec` 辅助写法，新增独立 spec）：

```js
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
```

**说明：** 上面这个用例轮次较多，为让测试可独立、简洁，另写两个聚焦用例（本轮每轮断言）：

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/state.test.js`
Expected: FAIL——skipped 记录缺失 / `s` 未被跳过（dead 传播未实现）。

- [ ] **Step 3: 实现 state.js 的 branch 剪枝**

修改 `backend/engine/state.js`：
- 顶部 import 增加：

```js
import { evalCond, buildCondCtx } from "./conditions.js";
```

- `advanceOnce` 内、`const done = new Set(snap.done ?? []);` 之后加快照字段归一化：

```js
    const nodeOutputs = snap.node_outputs ?? {};
    const loops = snap.loops ?? {};
    const skipped = new Set(snap.skipped ?? []);
```

- 在「处理本轮结果」循环里，`res.kind === "done"` 分支（第 99-104 行）开头加（先取节点引用，`node` 在该作用域未定义）：

```js
      const node = graph.nodes.get(nodeId);
      if (node?.type === "loop") {
        // loop 节点由引擎状态机驱动（Task 5），此处不 record、不注入输出
        continue;
      }
      nodeOutputs[nodeId] = res.output ?? {};
```

- 在处理完本轮结果后、`if (waitingNodes.length) waiting = waitingNodes;` 之后、完成判定之前插入 branch 剪枝块：

```js
    // ---- 控制节点：branch 边条件求值 + dead/skipped 传播（每轮幂等重算） ----
    const inactive = new Set(); // "from>to" 边未激活标记
    const edgeKey = (e) => `${e.from}>${e.to}`;
    // 0) 被跳过的 branch：其全部出边视为未激活（从未执行）
    for (const id of skipped) {
      const bn = graph.nodes.get(id);
      if (bn?.type === "branch") {
        for (const e of spec.edges ?? []) if (e.from === id) inactive.add(edgeKey(e));
      }
    }
    // 1) 已完成且未被跳过的 branch 节点：逐出边求值
    for (const bn of graph.nodes.values()) {
      if (bn.type !== "branch" || !done.has(bn.id) || skipped.has(bn.id)) continue;
      const condCtx = buildCondCtx({ triggerRaw: snap.trigger_raw, nodeOutputs, env: toFlat() });
      for (const e of spec.edges ?? []) {
        if (e.from !== bn.id) continue;
        if (e.cond && !evalCond(e.cond, condCtx)) inactive.add(edgeKey(e));
      }
    }
    if (inactive.size) {
      // 2) 不动点传播 dead：节点所有入边都未激活（或来自 dead）→ 该节点 dead，其出边也变未激活
      const dead = new Set();
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of graph.nodes.values()) {
          if (done.has(n.id) || dead.has(n.id)) continue;
          const parents = graph.parents[n.id] ?? [];
          if (!parents.length) continue; // 根节点（无入边）永不 dead
          const allInactive = parents.every((p) => dead.has(p) || inactive.has(`${p}>${n.id}`));
          if (allInactive) {
            dead.add(n.id);
            changed = true;
            for (const e of spec.edges ?? []) if (e.from === n.id) inactive.add(edgeKey(e));
          }
        }
      }
      // 3) dead 节点记为 done(skipped)
      for (const id of dead) {
        done.add(id);
        skipped.add(id);
        nodeOutputs[id] = { skipped: true };
        await record({ execId, nodeId: id, status: "skipped", output: { skipped: true } });
        await log(execId, `⏭ 节点 ${id} 因上游条件分支未命中被跳过`);
      }
    }
```

- 完成判定与快照落库处（第 118-126 行）改为携带新字段；**advanceOnce 返回的 snap 必须是全量快照**（含 trigger_raw/node_outputs/loops/skipped），否则 drain 循环与测试把上一轮 snap 传回下一轮时会丢条件上下文与迭代状态：

```js
    const fullSnap = () => ({
      done: [...done], waiting, environment: toFlat(),
      trigger_raw: snap.trigger_raw, node_outputs: nodeOutputs,
      loops, skipped: [...skipped],
    });
    if (done.size === graph.nodes.size && !waiting) {
      await snapshot(execId, { ...fullSnap(), status: "completed" });
      console.log(`[advance] exec=${execId} ✅ 全部 ${graph.nodes.size} 个节点已完成 → 执行标记为 completed，更新流水线运行状态`);
      await complete({ execId, status: "completed" });
      return { spec, snap: { ...fullSnap(), status: "completed" }, waiting: null };
    }
    await snapshot(execId, fullSnap());
    return { spec, snap: fullSnap(), waiting };
```

（`complete` 返回对象的 snap 仍按旧形态携带 done/waiting/environment，编排层只消费这些字段，不冲突。）

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/state.test.js`
Expected: PASS（既有用例 + 3 个新 branch 用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add backend/engine/state.js backend/engine/state.test.js
git commit -m "feat: 引擎支持 branch 边条件剪枝与 dead/skipped 传播（join 自然收敛）"
```

---

### Task 5: state.js loop 迭代状态机

**Files:**
- Modify: `backend/engine/state.js`
- Modify: `backend/engine/state.test.js`

- [ ] **Step 1: 写失败测试**

在 `backend/engine/state.test.js` 末尾追加：

```js
// ---------- 控制节点：loop 迭代状态机 ----------

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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/state.test.js`
Expected: FAIL——loop 未按迭代推进（仅 1 轮，无累积记录）。

- [ ] **Step 3: 实现 loop 状态机**

修改 `backend/engine/state.js`：
- 顶部 import 增加（`conditions.js` 已有 import 的直接复用）：

```js
import { JSONPath } from "jsonpath-plus";
import { loopRegionOf } from "./dag.js";
```

- `advanceOnce` 内加两个局部函数（放在 `fillEnv`/`normalizeWaiting` 外、`advanceOnce` 内均可——放 `createAdvancer` 顶层、`advanceOnce` 之前更清晰）：

```js
  // loop items 解析：{count} 固定次数展开 [1..N]；{path} JSONPath 取数组。
  // 空数组 → 0 次迭代（调用方负责把 body 标 skipped）。
  function resolveLoopItems(items, ctx) {
    if (items?.path) {
      let hit;
      try { hit = JSONPath({ path: items.path, json: ctx, wrap: false }); }
      catch { hit = undefined; }
      if (!Array.isArray(hit)) throw new Error(`loop items 路径未取到数组: ${items.path}`);
      return hit;
    }
    const n = Number(items?.count);
    if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) throw new Error(`loop count 非法: ${items?.count}`);
    return Array.from({ length: n }, (_, i) => i + 1);
  }
  // 把当前迭代的 item/iteration 写入环境（随快照 environment 持久化，回调续跑不丢）
  function setIterVars(loopId, st, env) {
    const it = st.items[st.idx];
    env.set("item", typeof it === "string" ? it : JSON.stringify(it));
    env.set("iteration", String(st.idx + 1));
  }
```

- 在「处理本轮结果」循环的 `res.kind === "done"` 分支，把 Task 4 加的 loop 跳过逻辑替换为完整初始化：

```js
      if (node.type === "loop") {
        // 初始化迭代状态：算出 bodyIds/items，loop 节点立即 done（放行 body），执行记录留到结束补记
        const condCtx = buildCondCtx({ triggerRaw: snap.trigger_raw, nodeOutputs, env: toFlat() });
        const items = resolveLoopItems(node.params?.items, condCtx);
        const { bodyIds, err } = loopRegionOf({ nodes: spec.nodes ?? [], edges: spec.edges ?? [], loopId: nodeId });
        if (err) throw new Error(`loop 配置非法: ${err}`);
        if (!items.length) {
          // 空迭代：body 全部 skipped，loop 节点直接完成（done），join 下一轮自然收敛
          for (const id of bodyIds) {
            if (done.has(id)) continue;
            done.add(id); skipped.add(id); nodeOutputs[id] = { skipped: true };
            await record({ execId, nodeId: id, status: "skipped", output: { skipped: true } });
          }
          done.add(nodeId);
          await record({ execId, nodeId, status: "done", output: {} });
          continue;
        }
        loops[nodeId] = { items, idx: 0, bodyIds, acc: {} };
        done.add(nodeId);
        setIterVars(nodeId, loops[nodeId], env);
        continue;
      }
      nodeOutputs[nodeId] = res.output ?? {};
```

- 在 branch 剪枝块之后、完成判定之前插入 loop 迭代边界检查：

```js
    // ---- 控制节点：loop 迭代边界（本轮 body 全部完成且无等待时推进/收敛） ----
    for (const [loopId, st] of Object.entries(loops)) {
      const bodyAllDone = st.bodyIds.every((id) => done.has(id));
      if (!bodyAllDone) continue;
      // 累积本轮输出
      const loopNode = graph.nodes.get(loopId);
      for (const acc of loopNode?.params?.accumulate ?? []) {
        const v = nodeOutputs[acc.from]?.[acc.field];
        if (v !== undefined && v !== null) (st.acc[acc.key] ??= []).push(v);
      }
      if (st.idx + 1 < st.items.length) {
        st.idx++;
        for (const id of st.bodyIds) done.delete(id); // 清掉 body 完成标记，下一轮重跑
        setIterVars(loopId, st, env);
      } else {
        // 循环结束：loop 节点补记执行记录（累积输出），清理迭代变量，join 自然就绪
        const out = Object.fromEntries(Object.entries(st.acc).map(([k, v]) => [k, JSON.stringify(v)]));
        await record({ execId, nodeId: loopId, status: "done", output: out });
        nodeOutputs[loopId] = out;
        fillEnv(env, out);
        for (const k of ["item", "iteration"]) env.delete(k);
        delete loops[loopId];
      }
    }
```

**并行 loop 限制说明：** 多个 loop 并行时共享 `item`/`iteration` 变量名会互相覆盖，v1 不校验也不支持并行 loop（普通节点约束已保证体内不嵌套；若出现并行 loop，以最后写入者为准）。前端手测清单不覆盖此场景。

- 完成判定/快照落库处的 `snapPayload` 已含 `loops`/`skipped`/`node_outputs`/`trigger_raw`（Task 4 已加），无需再改。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/state.test.js`
Expected: PASS（含 4 个新 loop 用例）。

- [ ] **Step 5: Commit**

```bash
git add backend/engine/state.js backend/engine/state.test.js
git commit -m "feat: 引擎支持 loop 子图循环（count/JSONPath 迭代、输出累积、空迭代跳过）"
```

---

### Task 6: orchestrator.js drain 循环与 markDone 快照透传

**Files:**
- Modify: `backend/engine/orchestrator.js`
- Modify: `backend/engine/orchestrator.test.js`

- [ ] **Step 1: 写失败测试**

在 `backend/engine/orchestrator.test.js` 末尾追加：

```js
import { createAdvancer } from "../engine/state.js";

test("drain：run 一次调用内连续推进同步链直到完成（sql→sql 不再卡住）", async () => {
  const spec = {
    execId: 21,
    nodes: [
      { id: "a", type: "sql", params: { statements: ["select 1"] } },
      { id: "b", type: "sql", params: { statements: ["select 2"] } },
    ],
    edges: [{ from: "a", to: "b" }],
  };
  const ran = [];
  const advancer = createAdvancer({
    stepRun: async (node) => { ran.push(node.id); return { kind: "done", output: { n: node.id } }; },
    snapshot: async () => {}, log: async () => {}, record: async () => {},
  });
  const orch = createOrchestrator({
    loadSpec: async () => spec,
    snapshotStore: { save: async () => {}, load: async () => ({}), clear: async () => {} },
    advance: advancer.advanceOnce,
    record: async () => {},
  });
  const out = await orch.run(spec);
  assert.deepEqual(ran.sort(), ["a", "b"], "同步链在单次 run 内推进完毕");
  assert.equal(out.snap.status, "completed");
});

test("drain：waiting 非空时立即停止（ECI/审批断点语义不变）", async () => {
  let calls = 0;
  const adv = async () => { calls++; return { snap: { done: ["a"], waiting: ["b"] }, waiting: ["b"] }; };
  const orch = createOrchestrator({
    loadSpec: async () => ({ execId: 1, nodes: [], edges: [] }),
    snapshotStore: { save: async () => {}, load: async () => ({}), clear: async () => {} },
    advance: adv, record: async () => {},
  });
  await orch.run({ execId: 1 });
  assert.equal(calls, 1, "waiting 即断点，不继续推进");
});

test("drain：本轮无任何进展时停止（死锁护栏，不无限循环）", async () => {
  let calls = 0;
  const adv = async () => { calls++; return { snap: { done: ["a"], waiting: null }, waiting: null }; };
  const orch = createOrchestrator({
    loadSpec: async () => ({ execId: 1, nodes: [], edges: [] }),
    snapshotStore: { save: async () => {}, load: async () => ({}), clear: async () => {} },
    advance: adv, record: async () => {},
  });
  await orch.run({ execId: 1 });
  assert.ok(calls >= 1 && calls <= 2, "无进展立即停止，不无限循环");
});

test("markDone 透传快照其余字段（loops/node_outputs/trigger_raw 不丢）", async () => {
  const saved = [];
  const orch = createOrchestrator({
    loadSpec: async () => ({ execId: 1, nodes: [], edges: [] }),
    snapshotStore: {
      save: async (id, s) => saved.push(s),
      load: async () => ({
        done: [], waiting: ["body"], environment: { item: "a" },
        loops: { l1: { items: ["a", "b"], idx: 0, bodyIds: ["body"], acc: {} } },
        node_outputs: { prev: { x: "1" } },
        trigger_raw: { refs: ["a", "b"] },
        skipped: [],
      }),
      clear: async () => {},
    },
    advance: async () => ({ snap: {}, waiting: null }),
    record: async () => {},
  });
  await orch.onEciDone({ execId: 1, nodeId: "body", output: "n=5" });
  const last = saved.at(-1);
  assert.deepEqual(last.loops, { l1: { items: ["a", "b"], idx: 0, bodyIds: ["body"], acc: {} } }, "loops 透传");
  assert.equal(last.node_outputs.body.n, "5", "回调输出写入 node_outputs");
  assert.deepEqual(last.trigger_raw, { refs: ["a", "b"] }, "trigger_raw 透传");
  assert.equal(last.skipped.length, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/orchestrator.test.js`
Expected: FAIL——第一个用例 `ran` 只有 `["a"]`（run 只推进一轮）；第四个用例 `last.loops` 为 undefined。

- [ ] **Step 3: 实现**

修改 `backend/engine/orchestrator.js`：

- 在 `createOrchestrator` 内、`withExclusive` 之后加 `drainAdvance`：

```js
  // 一次唤醒内连续推进同步节点：直到进入外部等待 / 全部完成 / 本轮无进展（死锁护栏）。
  // 控制节点（branch 剪枝、loop 迭代）依赖它在一个 FC 调用内跑完同步链路。
  async function drainAdvance({ spec, snap, execId, environment }) {
    let last = { snap, waiting: snap?.waiting ?? null };
    let prevDone = new Set(snap?.done ?? []);
    for (;;) {
      last = await advance({ spec, snap: last.snap, execId, environment });
      if (last.waiting) return last;                       // 有外部等待 → 断点返回（FC 释放）
      if (last.snap?.status === "completed") return last;  // 全部完成
      const now = last.snap?.done ?? [];
      if (now.length === prevDone.size) return last;       // 本轮无进展 → 死锁护栏
      prevDone = new Set(now);
    }
  }
```

- `run`（第 62-77 行）改为接收 `meta` 并调用 `drainAdvance`、透传 `trigger_raw`：

```js
  async function run(spec, environment, meta = {}) {
    return withExclusive(async () => {
      await snapshotStore.clear(spec.execId);
      await schedLog(spec.execId, "▶ 执行启动：清除旧快照，开始推进节点");
      console.log(`[run] exec=${spec.execId} 启动/续跑执行：已清除同 id 旧快照，开始推进节点`);
      const stored = (await snapshotStore.load(spec.execId)) ?? {};
      const env = buildEnv(stored.environment, environment);
      const snap = {
        ...stored,
        environment: stored.environment ?? {},
        trigger_raw: meta.triggerRaw ?? stored.trigger_raw,
      };
      return drainAdvance({ spec, snap, execId: spec.execId, environment: env });
    });
  }
```

- `markDone`（第 83-104 行）改为透传快照其余字段并写入 `node_outputs`：

```js
  async function markDone(nodeId, execId, failed, output) {
    const snap = (await snapshotStore.load(execId)) ?? {};
    const done = new Set(snap.done ?? []);
    done.add(nodeId);
    const waiting = normalizeWaiting(snap.waiting);
    const rest = waiting ? waiting.filter((id) => id !== nodeId) : null;
    // 透传快照其余字段（loops/node_outputs/trigger_raw/skipped），只覆盖本回调相关的部分——
    // 否则循环体内回调续跑会丢迭代状态与条件上下文
    const next = { ...snap, done: [...done], waiting: rest?.length ? rest : null };
    if (snap.environment || (output && Object.keys(output).length)) {
      next.environment = { ...(snap.environment ?? {}), ...(output ?? {}) };
    }
    if (!failed && output && typeof output === "object" && Object.keys(output).length) {
      next.node_outputs = { ...(snap.node_outputs ?? {}), [nodeId]: output };
    }
    if (failed) next.status = "failed";
    await snapshotStore.save(execId, next);
    await schedLog(execId, `节点 ${nodeId} 标记为${failed ? "失败" : "成功"}终态（已结束 ${done.size} 个节点）`);
    console.log(
      `[markDone] exec=${execId} 节点 ${nodeId} 标记为${failed ? "失败" : "成功"}终态，` +
      `已结束 ${done.size} 节点，剩余等待=${JSON.stringify(next.waiting)}，执行状态=${failed ? "failed" : snap.status ?? "running"}`
    );
    return next;
  }
```

- `onEciDone` / `onApproval`（第 111-155 行）改为调用 `drainAdvance` 续跑；`onApproval` 的 approve 分支给 `markDone` 传输出对象：

```js
    async onEciDone({ execId, nodeId, output, logs }) {
      return withExclusive(async () => {
        console.log(`[orchestrator] exec=${execId} 收到 ECI 节点 ${nodeId} 成功回调，解析输出并继续推进`);
        const parsed = parseOutput(output);
        const next = await markDone(nodeId, execId, false, parsed);
        await record({ execId, nodeId, status: "succeeded", output: parsed, logs });
        const spec = await loadSpecForExec(execId);
        const env = buildEnv(next.environment, parsed);
        return drainAdvance({ spec, snap: next, execId, environment: env });
      });
    },
```

```js
    async onApproval({ execId, nodeId, decision }) {
      return withExclusive(async () => {
        if (decision === "reject") {
          console.log(`[orchestrator] exec=${execId} 审批节点 ${nodeId} 被拒绝 → 执行标记为 failed（拒绝即失败）`);
          const next = await markDone(nodeId, execId, true);
          await record({ execId, nodeId, status: "rejected", output: { decision: "reject" } });
          await schedLog(execId, `✗ 审批被拒绝（节点 ${nodeId}），执行标记为失败`);
          await failExecution(execId);
          return { status: "failed", done: next.done };
        }
        console.log(`[orchestrator] exec=${execId} 审批节点 ${nodeId} 已通过 → 标记完成并继续推进下一个节点`);
        const next = await markDone(nodeId, execId, false, { decision: "approve" });
        await record({ execId, nodeId, status: "succeeded", output: { decision: "approve" } });
        await schedLog(execId, `✆ 审批通过（节点 ${nodeId}），继续推进后续节点`);
        const spec = await loadSpecForExec(execId);
        return drainAdvance({ spec, snap: next, execId, environment: buildEnv(next.environment, null) });
      });
    },
```

（`onEciFail` 不改——失败即终止，无需 drain。）

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/orchestrator.test.js`
Expected: PASS（4 个新用例 + 既有用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add backend/engine/orchestrator.js backend/engine/orchestrator.test.js
git commit -m "feat: 编排层 drain 循环与 markDone 快照透传（同步链一次跑完、循环体回调不丢状态）"
```

---

### Task 7: index.js 触发装配 triggerRaw + api.js 保存校验

**Files:**
- Modify: `backend/index.js`（`hydrateForRun` 返回 `triggerRaw`；三处 `orchestrator.run` 调用传入）
- Modify: `backend/handlers/api.js`（create/update 增加 `validateSpec`）
- Modify: `backend/handlers/api.test.js`（保存校验回归）

- [ ] **Step 1: 写失败测试**

在 `backend/handlers/api.test.js` 末尾追加（沿用该文件「动态 import + `assert.rejects(e => e.status === ...)`」风格）：

```js
test("创建管道：DAG 非法（loop 体内嵌套 branch）保存报 400 BAD_DAG", async () => {
  const { createPipeline } = await import("./api.js");
  const body = {
    name: "bad-loop",
    spec_json: {
      nodes: [
        { id: "l", type: "loop", params: { items: { count: 2 } } },
        { id: "b", type: "branch", params: {} },
        { id: "j", type: "join", params: {} },
      ],
      edges: [{ from: "l", to: "b" }, { from: "b", to: "j" }],
    },
  };
  await assert.rejects(
    () => createPipeline(body),
    (e) => e.status === 400 && e.code === "BAD_DAG" && String(e.message).includes("循环体内不允许 branch")
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test handlers/api.test.js`
Expected: FAIL——当前 create 不校验 DAG，创建成功未抛错。

- [ ] **Step 3: 实现**

修改 `backend/handlers/api.js`：
- 顶部 import 加 `validateSpec`（与 `checkVars` 同源，参照该文件既有 import 行）：

```js
import { validateSpec } from "../engine/dag.js";
```

- 在 `assertVarsResolved` 定义旁加 `assertDagValid`，并在 `createPipeline`/`updatePipeline` 调用：

```js
// 保存前 DAG 校验（节点唯一/边端点/无环/边条件格式/loop 区域）；非法直接 400
function assertDagValid(spec) {
  const checked = validateSpec(spec);
  if (!checked.ok) throw new HttpError(400, "BAD_DAG", "DAG 校验失败：" + checked.errors.join("；"));
}
```

```js
export async function createPipeline(body) {
  const specObj = resolveSpec(body);
  assertVarsResolved(specObj);
  assertDagValid(specObj);
  ...
}

export async function updatePipeline(id, body) {
  const specObj = resolveSpec(body);
  assertVarsResolved(specObj);
  assertDagValid(specObj);
  ...
}
```

修改 `backend/index.js`：
- `hydrateForRun`（第 433 行起）在构造 `trigger` 后、返回处增加 `triggerRaw`：

```js
  async function hydrateForRun({ pipelineId, kind, formValue, webhookBody, authority, rerunOf }) {
    const trigger = kind === "manual"
      ? { trigger: "manual", params: formValue ?? {} }
      : kind === "webhook" ? { trigger: "webhook", body: webhookBody ?? {} }
      : {};
    if (rerunOf != null) trigger.rerunOf = rerunOf;
    const triggerRaw = kind === "webhook" ? webhookBody : kind === "manual" ? formValue : undefined;
    ...
    return { spec, environment, triggerRaw };
  }
```

- 三处 `app.orchestrator.run(spec, environment)` 调用（`api.runPipeline` 第 548 行、`api.rerunExecution` 第 569 行、`hook.webhook` 第 634 行）改为：

```js
    const { spec, environment, triggerRaw } = await app.hydrateForRun({ ... });
    const out = await app.orchestrator.run(spec, environment, { triggerRaw });
```

（三处各自的 hydrateForRun 实参保持不变，只解构多一个 `triggerRaw` 并传给 `run`。）

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test handlers/api.test.js`
Expected: PASS。

- [ ] **Step 5: 全量后端回归**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test`
Expected: 全部 PASS（webhook.test / orchestrator.test / api.test 等既有链路不受影响）。

- [ ] **Step 6: Commit**

```bash
git add backend/index.js backend/handlers/api.js backend/handlers/api.test.js
git commit -m "feat: 触发装配传 triggerRaw；管道保存增加 DAG 校验（400 BAD_DAG）"
```

---

### Task 8: 前端节点库与节点表单（branch/join/loop）

**Files:**
- Modify: `frontend/src/pages/PipelineEdit.vue`

- [ ] **Step 1: NODE_KINDS 与 LIB_TYPES**

`NODE_KINDS`（第 360-365 行）追加三类（图标沿用线条风格）：

```js
  branch:  { label: "条件分支", accent: "var(--warn)",   icon: "M7 3v7a2 2 0 0 0 2 2h2m-4 9v-5m0 0h-3m3 0h3m4-9l5-5m0 0V3h-5m5 0v5" },
  join:    { label: "汇聚",     accent: "var(--accent)", icon: "M4 4h16M8 8h8M12 12v8M4 20h16" },
  loop:    { label: "循环",     accent: "var(--ember)",  icon: "M17 2l4 4-4 4m4-4H8a6 6 0 0 0-6 6v1m5 5l-4 4 4 4m-4-4h8a6 6 0 0 0 6-6v-1" },
```

`LIB_TYPES`（第 366 行）改为：

```js
const LIB_TYPES = ["shell", "approval", "sql", "branch", "join", "loop"];
```

- [ ] **Step 2: addNode 参数默认值**

`addNode`（第 671-683 行）的 `params` 三元链加分支（在 `: type === "sql" ? {...}` 之后、approval 三元之前插入）：

```js
          : type === "loop"
            ? { items: { count: 3 }, accumulate: [] }
            : type === "branch" || type === "join"
              ? {}
              : { robot: "", message: DEFAULT_APPROVAL_BODY, target: { type: "user", openIds: "", members: [] } },
```

- [ ] **Step 3: 浮窗表单**

在 `PipelineEdit.vue` 模板的浮窗 body 里、`<template v-if="n.type === 'shell'">` 之前插入三个 `v-else-if` 分支（第 1196-1197 行 `v-else v-for="n in [selected]"` 块内）：

```html
              <template v-else-if="n.type === 'branch'">
                <p class="field-hint">条件分支：为出边设置条件——选中连线后在画布上点击连线，浮窗切换为边配置。未命中条件的边及其下游节点将被跳过（执行详情显示「已跳过」）。</p>
                <p class="field-hint">不带条件的边恒激活，可作为默认兜底分支。</p>
              </template>
              <template v-else-if="n.type === 'join'">
                <p class="field-hint">汇聚点：等待所有已激活上游完成后放行；作为循环出口时由循环自动收敛。</p>
              </template>
              <template v-else-if="n.type === 'loop'">
                <div class="field">
                  <label class="field-label">迭代来源</label>
                  <div class="seg-tabs">
                    <button type="button" class="seg-tab" :class="{ active: loopItemsModeOf(n) === 'count' }" @click="setLoopItemsMode(n, 'count')">固定次数</button>
                    <button type="button" class="seg-tab" :class="{ active: loopItemsModeOf(n) === 'path' }" @click="setLoopItemsMode(n, 'path')">JSONPath 数组</button>
                  </div>
                  <input v-if="loopItemsModeOf(n) === 'count'" class="input mono" type="number" min="1" v-model.number="n.params.items.count" placeholder="循环次数，如 3" />
                  <input v-else class="input mono" v-model="n.params.items.path" placeholder="从触发载荷/上游输出取数组，如 $.trigger.refs" @focus="onFieldFocus($event, n, 'items.path')" />
                  <p class="field-hint">每轮注入 <code class="mono ph-code">${item}</code>（当前元素）与 <code class="mono ph-code">${iteration}</code>（1 起始序号）供循环体节点引用。</p>
                </div>
                <div class="field">
                  <label class="field-label">输出累积</label>
                  <div v-for="(a, i) in n.params.accumulate" :key="i" class="sql-out-row">
                    <input class="input mono" v-model="a.key" placeholder="输出 key" />
                    <select class="select" v-model="a.from">
                      <option value="">循环体节点…</option>
                      <option v-for="b in loopBody(n)" :key="b.id" :value="b.id">{{ b.name || drainId(b.id) }}</option>
                    </select>
                    <input class="input mono" v-model="a.field" placeholder="输出字段" />
                    <button type="button" class="btn btn-sm btn-danger" @click="n.params.accumulate.splice(i, 1)">删</button>
                  </div>
                  <div class="sql-actions">
                    <button type="button" class="btn btn-sm btn-ghost" @click="n.params.accumulate.push({ key: '', from: '', field: '' })">＋添加累积</button>
                  </div>
                  <p class="field-hint">每轮从所选循环体节点的输出取字段值累积成数组；循环结束后以 JSON 字符串注入该 key（如 <code class="mono ph-code">${shas}</code>）供下游引用。</p>
                </div>
              </template>
```

在 `<script setup>` 末尾（`addNode` 附近）加辅助函数：

```js
// loop 表单辅助：迭代来源切换与循环体节点列表（前端只读计算，不校验）
function loopItemsModeOf(n) { return n.params.items?.path ? "path" : "count"; }
function setLoopItemsMode(n, mode) {
  n.params.items = mode === "count" ? { count: n.params.items?.count ?? 3 } : { path: n.params.items?.path ?? "$.trigger.items" };
}
function loopBody(n) {
  const byId = new Map(nodes.value.map((x) => [x.id, x]));
  const edges = spec.value.edges ?? [];
  const succ = {}; const pred = {};
  for (const x of nodes.value) { succ[x.id] = []; pred[x.id] = []; }
  for (const e of edges) { succ[e.from].push(e.to); pred[e.to].push(e.from); }
  const seen = new Set(); const joins = [];
  const stack = [...(succ[n.id] ?? [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    if (byId.get(id)?.type === "join") { joins.push(id); continue; }
    for (const c of succ[id] ?? []) stack.push(c);
  }
  if (joins.length !== 1) return [];
  return [...seen].filter((id) => id !== joins[0]).map((id) => byId.get(id)).filter(Boolean);
}
```

（`drainId` 已存在，可直接用。）

- [ ] **Step 4: 构建回归**

Run: `cd frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: build 成功无报错。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/PipelineEdit.vue
git commit -m "feat: 节点库与浮窗支持 branch/join/loop（含 loop 迭代来源与输出累积表单）"
```

---

### Task 9: 前端边条件编辑与边徽标

**Files:**
- Modify: `frontend/src/pages/PipelineEdit.vue`

- [ ] **Step 1: 边选中与条件表单（script）**

- `COND_OPS` 常量（镜像后端白名单，放在 `NODE_KINDS` 附近）：

```js
const COND_OPS = ["eq", "ne", "gt", "ge", "lt", "le", "contains", "starts_with", "ends_with", "exists", "empty", "regex"];
const COND_OP_LABELS = { eq: "等于", ne: "不等于", gt: "大于", ge: "大于等于", lt: "小于", le: "小于等于", contains: "包含", starts_with: "以…开头", ends_with: "以…结尾", exists: "存在", empty: "为空", regex: "正则匹配" };
```

- 在 `selectedId` 声明旁加边选中态：

```js
// 边选中态：点选边进入边条件配置（与节点选中互斥：选择边时收起节点浮窗）
const selEdgeId = ref("");
const selEdge = computed(() => spec.value.edges.find((e) => edgeIdOf(e) === selEdgeId.value) ?? null);
function selectEdge(id) { selEdgeId.value = id; }
```

- `onPaneClick` 改为同时清边选中：

```js
function onPaneClick() { selectedId.value = ""; selEdgeId.value = ""; }
```

- 边条件写回（`v-model` 需要 getter/setter，或直接用 `input` 事件；为简洁用函数）：

```js
// 边条件编辑：直接改 spec.edges 中对应边的 cond 字段（null 表示无条件边）
function setEdgeCond(e, patch) { e.cond = { ...(e.cond ?? {}), ...patch }; }
```

- [ ] **Step 2: VueFlow 挂边事件与 vfEdges 透传 cond**

`vfEdges`（第 80-88 行）的 `data` 补 `cond`：

```js
  data: { from: e.from, to: e.to, cond: e.cond },
```

`<VueFlow>`（第 1042-1054 行）加 `@edge-click="onEdgeClick"`，并在 script 加：

```js
function onEdgeClick({ edge }) {
  selectedId.value = ""; // 选边时收起节点浮窗
  selEdgeId.value = edge.id;
}
```

既有 `onNodeClick`（第 147-150 行）末尾补一行清边选中（节点/边选中互斥）：

```js
function onNodeClick({ event, node }) {
  if (event.target?.closest?.(".vue-flow__handle")) return; // 拖手柄连线时不弹出面板
  selectNode(node.id);
  selEdgeId.value = ""; // 选中节点时收起边配置
}
```

- [ ] **Step 3: 边徽标渲染**

`#edge-default` 模板（第 1072-1083 行）在 `EdgeLabelRenderer` 内追加徽标（delete 按钮之后）：

```html
              <div v-if="slot.data?.cond" class="edge-cond nodrag" :style="edgeDelStyle(slot)"
                title="点击边配置条件" @click.stop="selectEdge(slot.id)">
                <span class="mono">{{ slot.data.cond.op }} {{ String(slot.data.cond.val ?? "") }}</span>
              </div>
              <div v-else-if="hoverEdgeId !== slot.id" class="edge-cond edge-cond-default nodrag" :style="edgeDelStyle(slot)"
                title="无条件边（默认激活）" @click.stop="selectEdge(slot.id)">
                <span class="mono">默认</span>
              </div>
```

（`slot.data` 即 vfEdges 的 data；`edgeDelStyle(slot)` 已给贝塞尔中点坐标。徽标可点击选中边。）

- [ ] **Step 4: 浮窗支持边模式**

浮窗入口 `v-if="selected"`（第 1094 行）改为：

```html
        <div v-if="selected || selEdge" class="param-float" :style="floatPos" @mousedown.stop>
```

浮窗头（第 1095-1103 行）改为按模式渲染（节点模式沿用现状；边模式显示边信息）：

```html
          <div class="float-head" @mousedown="startFloatDrag">
            <template v-if="selEdge && !selected">
              <span class="cfg-kind" style="background: var(--line-strong)">边条件</span>
              <span class="cfg-id mono">{{ drainId(selEdge.from) }} → {{ drainId(selEdge.to) }}</span>
              <span class="toolbox-spacer"></span>
              <button type="button" class="btn btn-sm btn-ghost" title="收起" @mousedown.stop @click="selEdgeId = ''">×</button>
            </template>
            <template v-else>
              <span class="cfg-kind" :style="{ backgroundColor: NODE_KINDS[selected.type].accent }">{{ NODE_KINDS[selected.type].label }}</span>
              <template v-if="!isTrigger(selected)">
                <input class="cfg-name-input" v-model="selected.name" :placeholder="NODE_KINDS[selected.type].label" title="节点名称（执行详情页展示用）" @mousedown.stop />
              </template>
              <span class="cfg-id mono">{{ drainId(selected.id) }}</span>
              <span class="toolbox-spacer"></span>
              <button type="button" class="btn btn-sm btn-ghost" title="收起" @mousedown.stop @click="selectedId = ''">×</button>
            </template>
          </div>
```

浮窗 body（第 1105 行 `<div class="float-body">` 开头）插入边模式内容：

```html
          <div class="float-body">
            <template v-if="selEdge && !selected">
              <div class="field">
                <label class="field-label">条件（JSONPath）</label>
                <input class="input mono" :value="selEdge.cond?.path ?? ''" placeholder="如 $.trigger.branch，或 $.outputs.shell1.code" @input="setEdgeCond(selEdge, { path: $event.target.value })" />
                <p class="field-hint">从触发载荷 / 上游节点输出 / 环境变量取值；留空表示无条件边（默认激活）。</p>
              </div>
              <div class="field" v-if="selEdge.cond">
                <label class="field-label">比较符</label>
                <select class="select" :value="selEdge.cond.op" @change="setEdgeCond(selEdge, { op: $event.target.value })">
                  <option v-for="op in COND_OPS" :key="op" :value="op">{{ COND_OP_LABELS[op] }}（{{ op }}）</option>
                </select>
              </div>
              <div class="field" v-if="selEdge.cond && !['exists', 'empty'].includes(selEdge.cond.op)">
                <label class="field-label">比较值</label>
                <input class="input mono" :value="selEdge.cond.val ?? ''" placeholder="字面量（字符串/数字/布尔）" @input="setEdgeCond(selEdge, { val: $event.target.value })" />
              </div>
              <div class="sql-actions" v-if="selEdge.cond">
                <button type="button" class="btn btn-sm btn-ghost" @click="selEdge.cond = null">设为无条件边</button>
              </div>
              <p class="field-hint">若在「无条件边」与「条件边」间切换，请点选下方按钮或清空 path。</p>
            </template>
```

（注意：`selEdge.cond = null` 直接改 spec 对象，视图由 `vfEdges` computed 自动刷新。）

- [ ] **Step 5: 样式**

`<style>` 内（`edge-del` 样式附近）追加：

```css
.edge-cond {
  position: absolute; transform: translate(-50%, -50%);
  background: rgba(13, 17, 23, 0.85); color: var(--warn);
  border: 1px solid var(--line); border-radius: 8px;
  padding: 1px 6px; font-size: 11px; line-height: 16px;
  cursor: pointer; pointer-events: auto; white-space: nowrap; z-index: 5;
}
.edge-cond-default { color: var(--text-3); }
```

- [ ] **Step 6: 构建回归**

Run: `cd frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: build 成功无报错。

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/PipelineEdit.vue
git commit -m "feat: 画布边条件编辑（选中边浮窗配置 JSONPath/比较符）与边徽标"
```

---

### Task 10: 执行详情 skipped 渲染 + 全量回归

**Files:**
- Modify: `frontend/src/pages/ExecutionDetail.vue`

- [ ] **Step 1: 状态表补 skipped**

`STATUS` 表（第 21-31 行）加一项：

```js
  skipped:   { label: "已跳过", cls: "badge-neutral", dot: "var(--text-3)" },
```

`canvasStatusColor`/`canvasStatusBg`（第 125-134 行附近）把 `skipped` 归入中性色：

```js
  if (["skipped", "cancelled"].includes(st)) return "var(--text-3)";
```

```js
  if (["skipped", "cancelled"].includes(s?.status)) return "rgba(120, 130, 145, 0.05)";
```

（若这两处当前没有 cancelled 分支，把 skipped 并入对应中性分支即可；具体行以实际文件为准。）

- [ ] **Step 2: 构建回归**

Run: `cd frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: build 成功无报错。

- [ ] **Step 3: 全量后端测试**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test`
Expected: 全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/ExecutionDetail.vue
git commit -m "feat: 执行详情页展示 skipped（已跳过）状态"
```

---

## 手测清单（交付前人工验证）

1. 节点库出现「条件分支 / 汇聚 / 循环」，点击/拖入可用；trigger 仍不可删。
2. 画布连线后点选边 → 浮窗切为边配置（path/op/val）；边中点显示徽标（条件边 `eq release`、无条件边「默认」）；「设为无条件边」可清除条件。
3. 手动运行 `trigger → branch → shell(s1) → join`，webhook body `{"branch":"release"}`：s1 执行、另一分支节点显示「已跳过」、join 收敛、执行 completed。
4. loop 固定次数 3 轮：循环体节点每轮重跑，`${item}`/`${iteration}` 在体内容器/变量里生效；accumulate 输出可在下游 `${nums}` 引用；loop 节点结束记录 output 含累积数组。
5. 非法 loop 区域（体内嵌套 branch、loop 直连 join、缺 join）保存报错（400 BAD_DAG），提示含具体节点。
6. 旧流水线（无控制节点）执行/编辑不受影响；执行详情页 branch/join/loop 与 skipped 渲染正常。
