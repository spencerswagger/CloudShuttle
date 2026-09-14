# 新建流程拆分 + 全画布编辑页重构 + 控制节点类型 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把新建流水线拆为「命名+触发源→保存→跳转编辑」，编辑页改为隐藏全局侧边栏的全画布三栏布局（左节点库/中画布/右悬浮参数浮层），并新增 branch/join/loop/node 四类控制节点（含 Loop 子流水线递归执行与分支剪枝）。

**Architecture:** 后端在现有 `spec_json.nodes/edges` 上加新节点类型；`validateSpec` 递归校验 loop 子 spec 且禁止回调节点（approval/shell 的 dispatch/wait 型）；`state.js` 的 `advanceOnce` 增加 branchChoices 剪枝与 `type:"loop"` 递归执行（子 spec 全 done 型 → 单次调用栈内同步完成，不经过 orchestrator 回调路径）。前端 `PipelineEdit.vue` 按 `isNew` 拆两种形态；编辑形态隐藏全局 sidebar（`meta.noSidebar`）改三栏；节点参数改悬浮浮层，变量面板并入；Loop 子画布为嵌套 VueFlow 浮层。

**Tech Stack:** 后端 Node ESM（node:test + assert/strict）；前端 Vue 3 + VueFlow（@vue-flow/core 已装）+ CodeMirror 6（新增 @codemirror/* 依赖）；数据库 PG + Redis 快照；测试命令 `cd backend && PATH="/usr/local/bin:$PATH" node --test`、`cd frontend && PATH="/usr/local/bin:$PATH" npm run build`。

**规格文档：** `docs/superpowers/specs/2026-09-11-dag-edit-rework-design.md`

---

## 文件结构总览

| 文件 | 责任 | 任务 |
|---|---|---|
| `backend/engine/dag.js` | validateSpec 新类型/递归子 spec 校验；buildGraph 加 edges 反向索引 | T1 |
| `backend/engine/dag.test.js` | 校验用例 | T1 |
| `backend/steps/trigger.js` + test | 起点节点 step（输出空） | T2 |
| `backend/steps/branch.js` + test | 多路 switch step（返回 branchChoice） | T2 |
| `backend/steps/join.js` + test | 汇聚 step（输出空） | T2 |
| `backend/steps/node.js` + test | Node 脚本子进程 step | T3 |
| `backend/engine/state.js` + test | branchChoices 剪枝 + loop 递归 | T4 |
| `backend/index.js` | STEP_TYPES/steps 装配、hydrateForRun 派生 trigger 节点 | T5 |
| `frontend/src/components/CodeEditor.vue` | CodeMirror 封装 | T6 |
| `frontend/package.json` | 新增 @codemirror 依赖 | T6 |
| `frontend/src/router.js` | `/pipelines/:id` 加 meta.noSidebar | T7 |
| `frontend/src/App.vue` | sidebar 按 meta.noSidebar 隐藏 | T7 |
| `frontend/src/pages/PipelineEdit.vue` | 新建形态 + 编辑形态三栏 + 悬浮浮层 + 新节点表单 + 子画布 | T7/T8/T9 |
| `frontend/src/pages/ExecutionDetail.vue` | 新节点状态适配 | T10 |

**环境变量/命名约定**（跨任务一致）：
- 新节点类型：`trigger`（起点）、`branch`、`join`、`loop`、`node`（脚本）。
- 回调节点类型（子 spec 禁止）：`approval`（wait）、`shell`（dispatch）。`sql`/`trigger`/`branch`/`join`/`node` 均为 done 型，子 spec 允许。
- Loop 节点参数：`node.params.loop = { items, subSpec:{nodes,edges}, concurrency, maxIter?, itemVar?, indexVar? }`，默认 `itemVar:"item"`、`indexVar:"index"`、`concurrency:1`。
- branch 参数：`node.params = { expr, cases:[{value, edge} | {default:true, edge}] }`。
- 快照新增字段：`snap.branchChoices = { [branchId]: edgeId }`。
- 子执行 execId：`${parentExecId}.it${i}`。

---

## Task 1: 后端 validateSpec/buildGraph 扩展（新类型 + 递归子 spec 校验）

**Files:**
- Modify: `backend/engine/dag.js`
- Test: `backend/engine/dag.test.js`

- [ ] **Step 1: 写失败测试**

在 `backend/engine/dag.test.js` 末尾追加：

```js
const TYPES = ["shell", "approval", "sql", "trigger", "branch", "join", "loop", "node"];

test("validateSpec 通过含全部新控制类型的 DAG", () => {
  const spec = {
    nodes: [
      { id: "t", type: "trigger", kind: "manual", params: {} },
      { id: "b", type: "branch", params: { expr: "${env}", cases: [{ value: "a", edge: "e1" }] } },
      { id: "j", type: "join", params: {} },
      { id: "l", type: "loop", params: { loop: { items: "${arr}", subSpec: { nodes: [{ id: "x", type: "node", params: { script: "console.log(JSON.stringify({}))" } }], edges: [] } } } },
      { id: "n", type: "node", params: { script: "console.log(JSON.stringify({ok:1}))" } },
    ],
    edges: [{ from: "t", to: "b" }, { from: "b", to: "j" }, { from: "j", to: "l" }, { from: "l", to: "n" }, { from: "b", to: "n" }],
  };
  const out = validateSpec(spec);
  assert.deepEqual(out, { ok: true, errors: [] });
});

test("validateSpec 拒绝超过一个 trigger 节点", () => {
  const spec = {
    nodes: [{ id: "a", type: "trigger", kind: "manual" }, { id: "b", type: "trigger", kind: "webhook" }],
    edges: [],
  };
  const out = validateSpec(spec);
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /trigger/i.test(e)));
});

test("validateSpec 拒绝 branch cases 指向不存在的边", () => {
  const spec = {
    nodes: [{ id: "b", type: "branch", params: { expr: "${x}", cases: [{ value: "a", edge: "ghost-edge" }] } }, { id: "n", type: "node", params: { script: "x" } }],
    edges: [{ from: "b", to: "n" }],
  };
  const out = validateSpec(spec);
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /ghost-edge/.test(e)));
});

test("validateSpec 递归校验 loop.subSpec，且子 spec 禁止回调节点（approval/shell）", () => {
  const spec = {
    nodes: [
      { id: "l", type: "loop", params: { loop: { items: "${arr}", subSpec: { nodes: [{ id: "x", type: "approval", params: {} }], edges: [] } } } },
    ],
    edges: [],
  };
  const out = validateSpec(spec);
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /approval/.test(e)));
});

test("validateSpec 拒绝 loop.subSpec 内的环", () => {
  const spec = {
    nodes: [
      { id: "l", type: "loop", params: { loop: { items: "${arr}", subSpec: { nodes: [{ id: "x", type: "node", params: { script: "a" } }, { id: "y", type: "node", params: { script: "b" } }], edges: [{ from: "x", to: "y" }, { from: "y", to: "x" }] } } } },
    ],
    edges: [],
  };
  const out = validateSpec(spec);
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /环|cycle/i.test(e)));
});

test("validateSpec 拒绝空脚本 node 节点", () => {
  const spec = { nodes: [{ id: "n", type: "node", params: { script: "" } }], edges: [] };
  const out = validateSpec(spec);
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /脚本|script/i.test(e)));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/dag.test.js`
Expected: 新增 6 个用例失败（validateSpec 尚未扩展，trigger 重复/边/子 spec 均未检出；空脚本也未检出）。

- [ ] **Step 3: 扩展 validateSpec 与 buildGraph**

修改 `backend/engine/dag.js`：

```js
// 回调节点类型：dispatch（shell 等 ECI）与 wait（approval）依赖外部回调续跑。
// loop 子 spec 递归在单次 advanceOnce 调用栈内同步完成，不允许此类节点，否则子执行无法在
// 一轮内收敛（等待回调需要 orchestrator 跨 execId 续跑链路，本期不引入）。
export const CALLBACK_TYPES = new Set(["shell", "approval"]);

function validateNode(n, errors) {
  if (!n || typeof n.id !== "string") { errors.push("节点缺少 id"); return; }
  if (!n.type) { errors.push(`节点 ${n.id} 缺少 type`); return; }
  if (n.type === "trigger") {
    if (n.kind !== "manual" && n.kind !== "webhook") errors.push(`trigger 节点 ${n.id} 的 kind 必须是 manual 或 webhook`);
  } else if (n.type === "branch") {
    const p = n.params ?? {};
    if (typeof p.expr !== "string" || !p.expr.trim()) errors.push(`branch 节点 ${n.id} 缺少 expr 表达式`);
  } else if (n.type === "loop") {
    const loop = n.params?.loop;
    if (!loop?.subSpec) { errors.push(`loop 节点 ${n.id} 缺少 loop.subSpec 子流水线`); return; }
    if (!Array.isArray(loop.subSpec.nodes) || loop.subSpec.nodes.length === 0) {
      errors.push(`loop 节点 ${n.id} 的 subSpec 至少需要一个节点`);
    }
  } else if (n.type === "node") {
    if (typeof n.params?.script !== "string" || !n.params.script.trim()) errors.push(`node 节点 ${n.id} 脚本内容为空`);
  }
}

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
  const children = {};
  for (const id of ids) { children[id] = []; }
  for (const e of edges) {
    if (!ids.has(e.from)) { errors.push(`边的起点不存在: ${e.from}`); continue; }
    if (!ids.has(e.to)) { errors.push(`边的终点不存在: ${e.to}`); continue; }
    children[e.from].push(e.to);
  }
  // 每类节点专项校验
  const triggers = [];
  for (const n of nodes) {
    validateNode(n, errors);
    if (n?.type === "trigger") triggers.push(n.id);
  }
  if (triggers.length > 1) errors.push(`至多允许一个 trigger 起点节点，当前有 ${triggers.length} 个`);
  // branch 的 cases[].edge 必须是对应节点的真实出边
  for (const n of nodes) {
    if (n?.type !== "branch") continue;
    const outEdges = new Set((edges.filter((e) => e.from === n.id)).map((e) => `e${e.from}>${e.to}`));
    for (const c of n.params?.cases ?? []) {
      if (c?.edge && !outEdges.has(c.edge)) errors.push(`branch 节点 ${n.id} 的 case 边 ${c.edge} 不存在`);
    }
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
  // loop 子 spec 递归校验：子 spec 内禁止回调节点；子 spec 自身也必须是合法 DAG
  for (const n of nodes) {
    if (n?.type !== "loop") continue;
    const sub = n.params?.loop?.subSpec;
    if (!sub) continue;
    for (const sn of sub.nodes ?? []) {
      if (CALLBACK_TYPES.has(sn?.type)) {
        errors.push(`loop 节点 ${n.id} 的子流水线不允许包含回调节点 ${sn.id}（${sn.type}），请改用 done 型节点（sql/trigger/branch/join/node）`);
      }
    }
    const subOut = validateSpec(sub);
    if (!subOut.ok) for (const e of subOut.errors) errors.push(`loop 节点 ${n.id} 的子流水线：${e}`);
  }
  return { ok: errors.length === 0, errors };
}
```

修改 `buildGraph`，加 `edgesByFrom` 反向索引（T2/T4 使用）：

```js
export function buildGraph(spec) {
  const nodes = new Map((spec.nodes ?? []).map((n) => [n.id, n]));
  const successors = {};
  const parents = {};
  const edgesByFrom = {};
  for (const n of nodes.keys()) { successors[n] = []; parents[n] = []; edgesByFrom[n] = []; }
  for (const e of spec.edges ?? []) {
    successors[e.from].push(e.to);
    parents[e.to].push(e.from);
    edgesByFrom[e.from].push(e);
  }
  return { nodes, successors, parents, edgesByFrom };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/dag.test.js`
Expected: 全部通过（旧 4 个 + 新 6 个）。同时跑全量 `node --test` 确认无回归。

- [ ] **Step 5: 提交**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline
git add backend/engine/dag.js backend/engine/dag.test.js
git commit -m "feat(engine): validateSpec 支持 trigger/branch/join/loop/node 类型并递归校验 loop 子流水线（禁回调节点）"
```

---

## Task 2: 后端 steps：trigger / branch / join

**Files:**
- Create: `backend/steps/trigger.js`、`backend/steps/branch.js`、`backend/steps/join.js`
- Create: `backend/steps/trigger.test.js`、`backend/steps/branch.test.js`、`backend/steps/join.test.js`

- [ ] **Step 1: 写失败测试（branch 核心：expr 求值与 case 匹配、默认分支、无命中报错）**

`backend/steps/branch.test.js`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { makeBranchStep } from "./branch.js";

const branchStep = makeBranchStep();
const env = new Map([["env", "prod"]]);
const ctx = { environment: env };

test("branch 命中指定 value → 返回对应 edge 的 branchChoice", async () => {
  const node = { id: "b", type: "branch", params: { expr: "${env}", cases: [{ value: "prod", edge: "e1" }] } };
  const res = await branchStep(node, ctx);
  assert.equal(res.kind, "done");
  assert.equal(res.branchChoice, "e1");
});

test("branch 无命中 → 走 default case", async () => {
  const node = { id: "b", type: "branch", params: { expr: "${env}", cases: [{ value: "staging", edge: "e1" }, { default: true, edge: "e2" }] } };
  const res = await branchStep(node, ctx);
  assert.equal(res.branchChoice, "e2");
});

test("branch 无命中且无 default → 抛人读错误", async () => {
  const node = { id: "b", type: "branch", params: { expr: "${env}", cases: [{ value: "staging", edge: "e1" }] } };
  await assert.rejects(() => branchStep(node, ctx), /未命中.*default|无默认分支/);
});

test("branch 未命中变量时按字面表达式求值", async () => {
  const node = { id: "b", type: "branch", params: { expr: "${missing}", cases: [{ default: true, edge: "e1" }] } };
  const res = await branchStep(node, ctx);
  assert.equal(res.branchChoice, "e1");
});
```

`backend/steps/trigger.test.js`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { makeTriggerStep } from "./trigger.js";

test("trigger step 返回 done 且输出为空（触发变量已由 hydrateForRun 注入 environment）", async () => {
  const step = makeTriggerStep();
  const node = { id: "t", type: "trigger", kind: "manual", params: {} };
  const res = await step(node, { environment: new Map([["foo", "1"]]) });
  assert.deepEqual(res, { kind: "done", output: {} });
});
```

`backend/steps/join.test.js`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { makeJoinStep } from "./join.js";

test("join step 返回 done 且输出为空（前驱输出已在 environment，环境为扁平 K=V 无法按节点分组，汇聚语义由引擎保证）", async () => {
  const step = makeJoinStep();
  const res = await step({ id: "j", type: "join", params: {} }, { environment: new Map([["k", "v"]]) });
  assert.deepEqual(res, { kind: "done", output: {} });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test steps/`
Expected: 三个新测试文件因模块不存在而失败（Cannot find module）。

- [ ] **Step 3: 实现三个 step**

`backend/steps/trigger.js`：

```js
// trigger 起点节点：触发变量（manual 表单值 / webhook 载荷）已由 hydrateForRun 的
// assembleTriggerEnv 注入执行环境，节点本身无副作用、无输出。
export function makeTriggerStep() {
  return async function triggerStep() {
    return { kind: "done", output: {} };
  };
}
```

`backend/steps/branch.js`：

```js
// 多路 switch：expr 渲染后与各 case.value 字符串精确匹配；命中返回该 case 的 edge，
// 引擎据此剪枝（只放行选中出边）；未命中走 default case；无 default 抛错。
export function makeBranchStep() {
  return async function branchStep(node, ctx) {
    const p = node.params ?? {};
    const expr = String(p.expr ?? "");
    const cases = Array.isArray(p.cases) ? p.cases : [];
    const fallback = cases.find((c) => c?.default === true);
    const hit = cases.find((c) => !c?.default && String(c.value) === expr);
    if (hit?.edge) return { kind: "done", output: {}, branchChoice: hit.edge };
    if (fallback?.edge) return { kind: "done", output: {}, branchChoice: fallback.edge };
    throw new Error(`分支节点 ${node.id} 未命中任何 case 且没有 default 分支（expr="${expr}"）`);
  };
}
```

`backend/steps/join.js`：

```js
// 汇聚点：等所有前驱 done/skipped 且至少一个真正执行后才由引擎置为就绪；
// 输出为空——前驱输出已铺平进 environment，下游可直接引用，无法也无须按节点分组回填。
export function makeJoinStep() {
  return async function joinStep() {
    return { kind: "done", output: {} };
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test steps/`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline
git add backend/steps/trigger.js backend/steps/trigger.test.js backend/steps/branch.js backend/steps/branch.test.js backend/steps/join.js backend/steps/join.test.js
git commit -m "feat(steps): 新增 trigger/branch/join 三个 done 型 step（branch 输出 branchChoice 供引擎剪枝）"
```

---

## Task 3: 后端 steps/node.js（Node 脚本子进程）

**Files:**
- Create: `backend/steps/node.js`、`backend/steps/node.test.js`

- [ ] **Step 1: 写失败测试**

`backend/steps/node.test.js`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { makeNodeStep } from "./node.js";

const step = makeNodeStep();
const env = new Map([["NAME", "world"]]);
const ctx = { environment: env };

test("函数模式：module.exports = async (env) => ({...}) 自动序列化为 stdout JSON", async () => {
  const node = { id: "n", type: "node", params: { script: "module.exports = async (env) => ({ hello: env.NAME });" } };
  const res = await step(node, ctx);
  assert.equal(res.kind, "done");
  assert.deepEqual(res.output, { hello: "world" });
});

test("命令模式：顶层代码自管 console.log(JSON.stringify(...))，可读 process.env", async () => {
  const node = { id: "n", type: "node", params: { script: "console.log(JSON.stringify({ sum: Number(process.env.A) + 1 }));" } };
  const env2 = new Map([["A", "41"]]);
  const res = await step(node, { environment: env2 });
  assert.equal(res.kind, "done");
  assert.deepEqual(res.output, { sum: 42 });
});

test("脚本退出非零 → 抛错且带 stderr 尾部", async () => {
  const node = { id: "n", type: "node", params: { script: "console.error('boom'); process.exit(3);" } };
  await assert.rejects(() => step(node, ctx), /exit 3.*boom|boom/);
});

test("stdout 非 JSON → 抛人读错误", async () => {
  const node = { id: "n", type: "node", params: { script: "console.log('not-json');" } };
  await assert.rejects(() => step(node, ctx), /不是合法 JSON/);
});

test("超时 → SIGKILL 并抛超时错误", async () => {
  const node = { id: "n", type: "node", params: { script: "setTimeout(() => {}, 60000);", timeoutSec: 1 } };
  await assert.rejects(() => step(node, ctx), /超时|timeout/i);
});

test("空脚本 → 抛错", async () => {
  const node = { id: "n", type: "node", params: { script: "   " } };
  await assert.rejects(() => step(node, ctx), /脚本内容为空/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test steps/node.test.js`
Expected: 全部失败（Cannot find module）。

- [ ] **Step 3: 实现 makeNodeStep**

`backend/steps/node.js`：

```js
// 执行 Node 脚本：独立子进程（--max-old-space-size 限制堆内存），支持两种写法：
//   1) 函数模式：module.exports = async (env) => ({...}) —— 返回值自动 JSON 序列化到 stdout；
//   2) 命令模式：任意顶层代码，自管 console.log(JSON.stringify({...})) 输出。
// 环境变量：ctx.environment 扁平 K=V 全部注入 process.env（脚本内可读）。
// 失败语义：退出码非 0 → 抛错（附 stderr 尾部）；stdout 非 JSON → 抛错；超时 → SIGKILL。
import { spawn } from "node:child_process";

export function makeNodeStep() {
  return async function nodeStep(node, ctx) {
    const p = node.params ?? {};
    const script = String(p.script ?? "").trim();
    if (!script) throw new Error("脚本内容为空");
    const timeoutSec = Number(p.timeoutSec) || 120;
    const maxMemoryMb = Number(p.maxMemoryMb) || 512;

    const envMap = ctx.environment instanceof Map ? ctx.environment : new Map();
    const env = { ...process.env };
    for (const [k, v] of envMap) env[k] = String(v);

    const wrapped = `(async () => {
      const module = { exports: {} };
      const exports = module.exports;
      try {
        ${script}
        if (typeof module.exports === "function") {
          const out = await module.exports(${JSON.stringify(Object.fromEntries(envMap))});
          console.log(JSON.stringify(out ?? {}));
        }
      } catch (e) {
        console.error(e?.stack || String(e));
        process.exit(1);
      }
    })();`;

    const child = spawn(process.execPath, [`--max-old-space-size=${maxMemoryMb}`, "-e", wrapped], {
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutSec * 1000);
    const code = await new Promise((resolve) => child.on("close", resolve));
    clearTimeout(timer);

    if (code === null) throw new Error(`脚本执行超时（${timeoutSec}s），已强制终止`);
    if (code !== 0) {
      const tail = String(stderr).trim().slice(-1000);
      throw new Error(`脚本执行失败（exit ${code}）：${tail || "无 stderr 输出"}`);
    }
    let output = {};
    try {
      output = JSON.parse(String(stdout).trim() || "{}");
    } catch {
      throw new Error("脚本 stdout 不是合法 JSON，请用 console.log(JSON.stringify({...})) 输出结果");
    }
    return { kind: "done", output };
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test steps/node.test.js`
Expected: 6 个用例全部通过（超时用例约 1s）。

- [ ] **Step 5: 提交**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline
git add backend/steps/node.js backend/steps/node.test.js
git commit -m "feat(steps): 新增 node 脚本 step（fork 子进程 + 超时/内存限制 + 函数/命令双模式）"
```

---

## Task 4: 引擎：branchChoices 剪枝 + loop 递归执行（state.js）

**Files:**
- Modify: `backend/engine/state.js`
- Test: `backend/engine/state.test.js`

**语义（实现前必读）：**
- `snap.branchChoices = { [branchId]: edgeId }`：branch 节点执行结果持久化，续跑不再重求值。
- 每轮推进前计算剪枝（不动点）：
  - 直接候选 C = 所有 branch 未选中出边的 target；
  - 对每个未 done 节点 v，令 d = 前驱中 done 数、s = 前驱中 skipped 数：
    - d + s < parents 总数 → 继续等；
    - d ≥ 1 → 若 v ∈ C 且非 join → skipped；否则就绪（join 恒就绪）；
    - d = 0（全部前驱 skipped）→ skipped（含 join）。
  - skipped 节点写入记录（status "skipped"）并并入 done 集合（视为已满足），继续传播直到不动点。
- loop 递归：`type:"loop"` 节点不进 stepRun，由 advanceOnce 内部 `runLoop` 处理——按 `loop.items` 切分迭代（JSON 数组或逗号分隔），逐迭代（并发=concurrency，默认 1）调用自身 `advanceOnce` 跑子 spec（`subExecId = ${execId}.it${i}`），子 spec 全 done 型 → 单轮收敛；迭代失败（子 done 未满）按 `onError`（默认 stop）处理；Loop 输出 `{ results: "<JSON 字符串>" }`（对象数组经 fillEnv 会 String 污染，故预序列化，下游用 `${results}` 拿到字符串再解析）。

- [ ] **Step 1: 写失败测试**

在 `backend/engine/state.test.js` 末尾追加（沿用该文件已有的 makeStep 型工具与 assert 风格；若文件内已有 `snap()`/`step()` 辅助请复用）：

```js
// ---- 控制节点：branch 剪枝 / join 汇聚 / loop 递归 ----

function makeAdvancerFor(steps) {
  return createAdvancer({
    stepRun: async (node, ctx) => {
      const s = steps[node.type];
      if (!s) throw new Error(`no step ${node.type}`);
      return s(node, ctx);
    },
    snapshot: async () => {},
    record: async () => {},
    complete: async () => {},
    log: async () => {},
  });
}

test("branch 未选中分支剪枝（skipped 并入 done），选中分支与 join 执行，整图 completed", async () => {
  const spec = {
    nodes: [
      { id: "t", type: "trigger", kind: "manual", params: {} },
      { id: "b", type: "branch", params: { expr: "${env}", cases: [{ value: "a", edge: "eb>x" }, { default: true, edge: "eb>y" }] } },
      { id: "x", type: "shell", params: {} },
      { id: "y", type: "shell", params: {} },
      { id: "j", type: "join", params: {} },
      { id: "z", type: "shell", params: {} },
    ],
    edges: [
      { from: "t", to: "b" },
      { from: "b", to: "x" },
      { from: "b", to: "y" },
      { from: "x", to: "j" },
      { from: "y", to: "j" },
      { from: "j", to: "z" },
    ],
  };
  const advancer = makeAdvancerFor({
    trigger: async () => ({ kind: "done", output: {} }),
    branch: async (node) => {
      const c = node.params.cases.find((c) => !c.default);
      return { kind: "done", output: {}, branchChoice: c.edge };
    },
    join: async () => ({ kind: "done", output: {} }),
    shell: async () => ({ kind: "done", output: {} }),
  });
  const env = new Map([["env", "a"]]);
  const res = await advancer.advanceOnce({ spec, snap: { done: [], waiting: null }, execId: "e1", environment: env });
  assert.equal(res.snap.status, "completed");
  const done = new Set(res.snap.done);
  assert.ok(done.has("t") && done.has("b") && done.has("x") && done.has("j") && done.has("z"));
  assert.ok(done.has("y")); // 剪枝节点以 skipped 并入 done
});

test("loop 串行迭代：子 spec 每轮注入 item/index，输出 results JSON 字符串", async () => {
  const subSpec = {
    nodes: [{ id: "s", type: "sql", params: { statements: ["SELECT 1"] } }],
    edges: [],
  };
  const spec = {
    nodes: [{ id: "l", type: "loop", params: { loop: { items: "${items}", subSpec, concurrency: 1, itemVar: "item", indexVar: "index" } } }],
    edges: [],
  };
  const seen = [];
  const advancer = makeAdvancerFor({
    loop: async () => { throw new Error("loop 不应走 stepRun"); },
    sql: async (node, ctx) => {
      seen.push([ctx.environment.get("item"), ctx.environment.get("index")]);
      return { kind: "done", output: { v: ctx.environment.get("item") } };
    },
  });
  const env = new Map([["items", JSON.stringify(["a", "b", "c"])]]);
  const res = await advancer.advanceOnce({ spec, snap: { done: [], waiting: null }, execId: "e2", environment: env });
  assert.equal(res.snap.status, "completed");
  assert.deepEqual(seen, [["a", "0"], ["b", "1"], ["c", "2"]]);
  const results = JSON.parse(res.snap.environment.results);
  assert.equal(results.length, 3);
  assert.equal(results[1].output.v, "b");
});

test("loop 迭代失败默认 stop → 父执行失败", async () => {
  const subSpec = { nodes: [{ id: "s", type: "sql", params: {} }], edges: [] };
  const spec = {
    nodes: [{ id: "l", type: "loop", params: { loop: { items: "${items}", subSpec, concurrency: 1 } } }],
    edges: [],
  };
  let calls = 0;
  const advancer = makeAdvancerFor({
    loop: async () => { throw new Error("loop 不应走 stepRun"); },
    sql: async () => {
      calls++;
      if (calls === 2) throw new Error("第二次迭代失败");
      return { kind: "done", output: {} };
    },
  });
  const env = new Map([["items", JSON.stringify(["a", "b"])]]);
  const res = await advancer.advanceOnce({ spec, snap: { done: [], waiting: null }, execId: "e3", environment: env });
  assert.equal(res.snap.status, "failed");
  assert.equal(calls, 2);
});

test("loop items 支持逗号分隔字符串", async () => {
  const subSpec = { nodes: [{ id: "s", type: "sql", params: {} }], edges: [] };
  const spec = {
    nodes: [{ id: "l", type: "loop", params: { loop: { items: "${csv}", subSpec } } }],
    edges: [],
  };
  const seen = [];
  const advancer = makeAdvancerFor({
    loop: async () => { throw new Error("loop 不应走 stepRun"); },
    sql: async (node, ctx) => { seen.push(ctx.environment.get("item")); return { kind: "done", output: {} }; },
  });
  const res = await advancer.advanceOnce({ spec, snap: { done: [], waiting: null }, execId: "e4", environment: new Map([["csv", "x,y,z"]]) });
  assert.equal(res.snap.status, "completed");
  assert.deepEqual(seen, ["x", "y", "z"]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/state.test.js`
Expected: 新增 4 个用例失败（loop 无 step、剪枝未实现）。

- [ ] **Step 3: 实现剪枝 + loop 递归（state.js）**

在 `backend/engine/state.js` 顶部 `import` 后新增辅助，并改造 `advanceOnce`：

```js
import { buildGraph, nextReady, CALLBACK_TYPES } from "./dag.js";
import { renderParams } from "./variables.js";
import { makeTriggerStep } from "../steps/trigger.js";
import { makeBranchStep } from "../steps/branch.js";
import { makeJoinStep } from "../steps/join.js";
import { makeNodeStep } from "../steps/node.js";

// loop items 解析：JSON 数组字符串 / 原生数组 / 逗号分隔字符串 → 数组
function parseLoopItems(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw == null) return [];
  const s = String(raw).trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try { const v = JSON.parse(s); if (Array.isArray(v)) return v; } catch { /* 落到逗号分隔 */ }
  }
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

// 剪枝不动点：branch 未选中边的 target 及「前驱全 done/skipped」的后继，标记 skipped。
// join 例外：有真正执行的前驱（d>=1）时恒就绪；全部前驱 skipped 时也 skipped。
function pruneSkipped(graph, done, branchChoices) {
  const skipped = new Set();
  const candidate = new Set();
  for (const [branchId, chosenEdgeId] of Object.entries(branchChoices ?? {})) {
    for (const e of graph.edgesByFrom[branchId] ?? []) {
      const eid = `e${e.from}>${e.to}`;
      if (eid !== chosenEdgeId) candidate.add(e.to);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const id in graph.parents) {
      if (done.has(id) || skipped.has(id)) continue;
      const parents = graph.parents[id] ?? [];
      const d = parents.filter((p) => done.has(p)).length;
      const s = parents.filter((p) => skipped.has(p)).length;
      if (d + s < parents.length) continue; // 有前驱未决
      const isJoin = graph.nodes.get(id)?.type === "join";
      if (d >= 1) {
        if (candidate.has(id) && !isJoin) { skipped.add(id); changed = true; }
      } else if (s > 0) {
        skipped.add(id); changed = true;
      }
    }
  }
  return skipped;
}
```

在 `createAdvancer` 内新增 loop 处理，并改造 `advanceOnce`：

```js
export function createAdvancer({ stepRun, snapshot, record, recordRegistry = async () => {}, complete = async () => {}, log = async () => {}, mutex }) {
  // 控制型 step 内置（trigger/branch/join/node 为 done 型；loop 由引擎递归，不走 stepRun）
  const ctl = {
    trigger: makeTriggerStep(),
    branch: makeBranchStep(),
    join: makeJoinStep(),
    node: makeNodeStep(),
  };

  // loop 递归：子 spec 全 done 型（validateSpec 已保证禁回调节点）→ 单次调用栈内收敛。
  // 返回 { kind:"done", output:{ results } }；迭代失败按 loop.onError（默认 stop）处理。
  async function runLoop(node, env, ctx, branchChoicesRef) {
    const loop = node.params.loop ?? {};
    const items = parseLoopItems(loop.items);
    const limited = loop.maxIter ? items.slice(0, Number(loop.maxIter)) : items;
    const concurrency = Math.max(1, Number(loop.concurrency) || 1);
    const itemVar = loop.itemVar || "item";
    const indexVar = loop.indexVar || "index";
    const onError = loop.onError || "stop";

    const results = new Array(limited.length);
    let failed = null;

    async function runIteration(item, i) {
      const subExecId = `${ctx.execId}.it${i}`;
      const subEnv = new Map(env);
      subEnv.set(itemVar, String(item));
      subEnv.set(indexVar, String(i));
      const subSnap = { done: [], waiting: null, branchChoices: {}, environment: {} };
      const subRes = await advanceOnce({ spec: loop.subSpec, snap: subSnap, execId: subExecId, environment: subEnv });
      const doneSet = new Set(subRes.snap.done ?? []);
      const total = (loop.subSpec?.nodes ?? []).length;
      if (doneSet.size < total) {
        const msg = `迭代 ${i}（item=${item}）未完成（done ${doneSet.size}/${total}）`;
        throw new Error(msg);
      }
      results[i] = { item, output: subRes.snap.environment ?? {} };
    }

    if (concurrency === 1) {
      for (let i = 0; i < limited.length; i++) {
        try { await runIteration(limited[i], i); }
        catch (err) {
          failed = err;
          if (onError !== "continue") break;
        }
      }
    } else {
      const batches = [];
      for (let i = 0; i < limited.length; i += concurrency) batches.push(limited.slice(i, i + concurrency).map((item, k) => ({ item, i: i + k })));
      for (const batch of batches) {
        const out = await Promise.allSettled(batch.map(({ item, i }) => runIteration(item, i)));
        for (const r of out) {
          if (r.status === "rejected") { failed = r.reason; if (onError !== "continue") break; }
        }
        if (failed && onError !== "continue") break;
      }
    }

    if (failed) throw failed;
    return { kind: "done", output: { results: JSON.stringify(results) } };
  }

  async function advanceOnce({ spec, snap, execId, environment }) {
    const graph = buildGraph(spec);
    const done = new Set(snap.done ?? []);
    let waiting = normalizeWaiting(snap.waiting);
    const branchChoices = { ...(snap.branchChoices ?? {}) };

    const env = new Map();
    fillEnv(env, snap.environment);
    fillEnv(env, environment);
    const toFlat = () => Object.fromEntries(env);

    if (waiting) {
      console.log(`[advance] exec=${execId} 存在等待回调的节点 node=${JSON.stringify(waiting)}，本次不推进，已结束节点数=${done.size}`);
      return { spec, snap: { done, waiting, environment: toFlat() }, waiting };
    }

    // 剪枝先行：branchChoices 未选中分支的节点标记 skipped 并入 done（记录 skipped）
    const skipped = pruneSkipped(graph, done, branchChoices);
    for (const id of skipped) {
      if (!done.has(id)) {
        done.add(id);
        await record({ execId, nodeId: id, status: "skipped", output: {} });
        await log(execId, `✂ 节点 ${id} 因分支未命中被剪枝（skipped）`);
      }
    }

    const ready = nextReady(graph, done);
    const summary = `已结束 ${done.size}/${graph.nodes.size} 个节点，就绪节点=[${ready.join(",") || "无"}]`;
    await log(execId, `推进一轮：${summary}`);
    console.log(`[advance] exec=${execId} 推进一轮：已结束节点 ${done.size}/${graph.nodes.size}，等待=${waiting ?? "无"}，本次就绪可执行节点=[${ready.join(",") || "无"}]`);
    if (!ready.length && done.size < graph.nodes.size) {
      console.warn(`[advance] exec=${execId} 没有可执行的就绪节点(已结束 ${done.size}/${graph.nodes.size})，疑似被上游未完成节点阻塞 nodes=[${[...graph.nodes.keys()].join(",")}]`);
    }

    const toRun = ready;

    const results = await Promise.allSettled(
      toRun.map(async (nodeId) => {
        try {
          const node = graph.nodes.get(nodeId);
          const renderedNode = { ...node, params: renderParams(node.params, env) };
          const ctx = { done: [...done], spec, execId, environment: env, recordRegistry };
          await log(execId, `⟶ 开始执行节点 ${nodeId}（类型 ${node.type}）`);
          if (node.type === "loop") {
            const res = await runLoop(renderedNode, env, ctx, branchChoices);
            return { nodeId, res };
          }
          const step = ctl[node.type] ?? stepRun;
          const res = await step(renderedNode, ctx);
          return { nodeId, res };
        } catch (err) {
          return { nodeId, error: err };
        }
      })
    );
    const waitingNodes = [];
    for (const r of results) {
      const { nodeId, res, error } = r.value;
      if (error) {
        console.error(`[advance] exec=${execId} 节点 ${nodeId} 并发执行失败: ${error?.message ?? error}`);
        await record({ execId, nodeId, status: "failed", output: { error: error?.message ?? String(error) } });
        done.add(nodeId); // 失败节点视为已结束（终态），否则 done 永不满足导致卡死
        continue;
      }
      if (res.kind === "done") {
        done.add(nodeId);
        if (res.branchChoice) branchChoices[nodeId] = res.branchChoice;
        fillEnv(env, res.output);
        console.log(`[advance] exec=${execId} ✔ 节点 ${nodeId} 就地完成，已写入节点记录`);
        await record({ execId, nodeId, status: "done", output: res.output, logs: res.logs });
        await log(execId, `✔ 节点 ${nodeId} 完成`);
      } else {
        waitingNodes.push(nodeId);
        console.log(`[advance] exec=${execId} ⏸ 节点 ${nodeId} 进入${res.kind === "wait" ? "外部等待" : "派发"}状态 ref=${res.ref ?? "-"}，等待外部回调`);
        await record({ execId, nodeId, status: res.kind, ref: res.ref });
        await log(execId, `⏸ 节点 ${nodeId} 进入${res.kind === "wait" ? "外部等待" : "派发"}状态，等待回调`);
      }
    }
    if (waitingNodes.length) waiting = waitingNodes;

    // 失败节点（error 分支）已并入 done；执行整体失败判定：任一节点 failed 则整执行 failed
    const hasFailed = [...done].some((id) => {
      return results.some((r) => r.value?.nodeId === id && r.value?.error);
    });

    if (done.size === graph.nodes.size && !waiting) {
      const status = hasFailed ? "failed" : "completed";
      await snapshot(execId, { done: [...done], waiting: null, branchChoices, status, environment: toFlat() });
      console.log(`[advance] exec=${execId} ✅ 全部 ${graph.nodes.size} 个节点已完成 → 执行标记为 ${status}`);
      await complete({ execId, status });
      return { spec, snap: { done, waiting: null, branchChoices, status, environment: toFlat() }, waiting: null };
    }

    await snapshot(execId, { done: [...done], waiting, branchChoices, environment: toFlat() });
    return { spec, snap: { done, waiting, branchChoices, environment: toFlat() }, waiting };
  }

  return { advanceOnce };
}
```

> **实现要点（务必逐条核对）**：
> 1. 失败节点并入 done 集合（否则 done.size 永远 < nodes.size 卡死）；`hasFailed` 只用于整执行终态判定。注意：`hasFailed` 需要跨轮记忆——**改：失败判定应基于快照**。将失败状态写入 `snap.failed = true` 并在 `snap.failed` 为真时终态 failed。修正：`const failedFlag = snap.failed === true || results.some((r) => r.value?.error)`，终态快照写 `failed: failedFlag`。
> 2. branch 的 branchChoice 存入 `branchChoices` 并持久化到快照（续跑后剪枝仍正确）。
> 3. loop 递归调用 `advanceOnce` 时会再走 `pruneSkipped`/`nextReady`，子 spec 无 branch 则跳过，无副作用；子执行 `complete` 闭包会以 `subExecId` 调父 `complete`——`complete` 内 `UPDATE execution WHERE id=$1` 对不存在的子 id 无行更新，安全。
> 4. 剪枝传播后 `nextReady` 用「done 含 skipped」判定，普通节点前驱含 skipped 时不会就绪（skipped 在 done 里但语义上是「未执行」）——**注意**：`nextReady` 只看 parents 是否都在 done；skipped 已并入 done，导致**普通节点会把「被剪枝前驱」当成就绪条件满足而执行**！这是 bug。
>
> **剪枝后必须把 skipped 从 done 中剔除再算 ready？** 不行——skipped 不入 done 则 completed 判定不成立。正确做法：`nextReady` 前把 skipped 节点**从 done 剔除**用于就绪判定，但 completed 判定用「done ∪ skipped == nodes」。改 `nextReady` 调用为：`nextReady(graph, new Set([...done].filter((id) => !skipped.has(id))))`，并把「done.size === graph.nodes.size」改为「done ∪ skipped 覆盖全部节点」。
>
> 这是本任务最容易踩的坑，直接采用修正后的实现（Step 3 代码已按此写）：就绪判定用 `doneExec = done 剔除 skipped`；终态判定用 `done.size === graph.nodes.size`（done 已含 skipped）。

> **修正 Step 3 的 advanceOnce 终态判定与就绪判定**（避免歧义，直接采用）：

```js
    // 剪枝先行（实现同上）……
    const doneExec = new Set([...done].filter((id) => !skipped.has(id)));
    const ready = nextReady(graph, doneExec);
    // 终态判定：done（含 skipped）覆盖全部节点
    if (done.size === graph.nodes.size && !waiting) { … }
```

> **迭代失败传播**：`runLoop` throw 后由外层 `try/catch` 捕获 → 该节点 record failed + 并入 done。若 `onError:"continue"`，失败迭代不阻断后续，但**失败信息**需要保留——`runLoop` 返回 `{ kind:"done", output:{ results, errors: JSON.stringify(failedArray) } }`。Step 3 的简化实现（抛错即停）满足默认 stop 语义；continue 语义在 T5 回归前补：把 `failed` 数组化，continue 时收集不抛。为控制本任务范围：**本期 `runLoop` 只支持默认 stop（onError 留参数位，文档说明 continue 未启用）**，避免计划膨胀。validateSpec 不校验 onError 值。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/state.test.js`
Expected: 新增 4 个用例通过，旧用例无回归（注意旧用例若有「失败节点不入 done」的断言会冲突——若有，按「失败并入 done」语义更新旧断言）。

- [ ] **Step 5: 全量回归 + 提交**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test`
Expected: 全部通过。

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline
git add backend/engine/state.js backend/engine/state.test.js
git commit -m "feat(engine): branchChoices 分支剪枝（skipped 并入 done）+ loop 递归执行（子 spec 同步收敛、输出 results JSON）"
```

---

## Task 5: 后端装配：STEP_TYPES / steps / hydrateForRun 派生 trigger 节点

**Files:**
- Modify: `backend/index.js`
- Test: `backend/engine/trigger.test.js`（或新建 handler 级用例）

- [ ] **Step 1: 写失败测试（hydrateForRun 为旧数据派生 trigger 起点节点）**

在 `backend/engine/trigger.test.js` 追加（该文件已 import `hydrateForRun` 相关？若无，改在 `backend/index.test.js` 或新增 `backend/hydrate.test.js`——先确认现有 trigger.test.js 测的是 engine/trigger.js 的纯函数；若不便测 index.js 内部函数，则此用例放 handler 级。**决策**：派生逻辑放 `backend/engine/trigger.js` 导出纯函数 `deriveTriggerNode(spec)`，index.js 调用，测试放 `trigger.test.js`）：

```js
import { deriveTriggerNode } from "./trigger.js";

test("deriveTriggerNode：旧 spec（nodes 无 trigger）按顶层 trigger.kind 派生起点节点", () => {
  const spec = {
    trigger: { kind: "webhook", params: [{ key: "env" }] },
    nodes: [{ id: "a", type: "sql", params: {} }],
    edges: [],
  };
  const node = deriveTriggerNode(spec);
  assert.ok(node);
  assert.equal(node.type, "trigger");
  assert.equal(node.kind, "webhook");
});

test("deriveTriggerNode：nodes 已有 trigger 节点则不重复派生", () => {
  const spec = {
    trigger: { kind: "manual" },
    nodes: [{ id: "t", type: "trigger", kind: "manual", params: {} }, { id: "a", type: "sql", params: {} }],
    edges: [],
  };
  assert.equal(deriveTriggerNode(spec), null);
});

test("deriveTriggerNode：无顶层 trigger 信息 → null", () => {
  assert.equal(deriveTriggerNode({ trigger: {}, nodes: [], edges: [] }), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/trigger.test.js`
Expected: 新增 3 个用例失败（deriveTriggerNode 未导出）。

- [ ] **Step 3: 实现 deriveTriggerNode + index.js 装配**

`backend/engine/trigger.js` 末尾追加：

```js
// 兼容旧数据：spec.nodes 无 trigger 起点节点时，按顶层 spec.trigger.kind 派生一个；
// 已有则返回 null（不重复）。新建流水线由前端直接写入 trigger 节点。
export function deriveTriggerNode(spec) {
  const nodes = spec?.nodes ?? [];
  if (nodes.some((n) => n?.type === "trigger")) return null;
  const kind = spec?.trigger?.kind;
  if (kind !== "manual" && kind !== "webhook") return null;
  return { id: "t0", type: "trigger", kind, params: {}, position: { x: 60, y: 60 } };
}
```

`backend/index.js` 修改：

1. 导入处（第 17-19 行 steps 导入附近）追加：

```js
import { deriveTriggerNode } from "./engine/trigger.js";
```

2. STEP_TYPES（第 266 行）改为：

```js
export const STEP_TYPES = ["shell", "approval", "sql", "trigger", "branch", "join", "node"];
```

3. buildApp 的 steps 装配（第 346-356 行）追加四个 step（loop 由引擎递归，不进 steps）：

```js
  const steps = {
    shell: makeShellStep({ … }),
    approval: makeApprovalStep({ … }),
    sql: makeSqlStep({ … }),
    trigger: (await import("./steps/trigger.js")).makeTriggerStep(),
    branch: (await import("./steps/branch.js")).makeBranchStep(),
    join: (await import("./steps/join.js")).makeJoinStep(),
    node: (await import("./steps/node.js")).makeNodeStep(),
  };
```

> 注：若 buildApp 是同步函数不能 await import，则改为顶部静态导入（与现有 import 风格一致）：

```js
import { makeTriggerStep } from "./steps/trigger.js";
import { makeBranchStep } from "./steps/branch.js";
import { makeJoinStep } from "./steps/join.js";
import { makeNodeStep } from "./steps/node.js";
// steps 装配处：
    trigger: makeTriggerStep(),
    branch: makeBranchStep(),
    join: makeJoinStep(),
    node: makeNodeStep(),
```

4. hydrateForRun（第 438-442 行）在 `loadPipelineRev` 后、validateSpec 前派生起点节点：

```js
    const spec = await loadPipelineRev(pipelineId, trigger, authority ? { authority } : undefined);
    // 旧数据兼容：nodes 无 trigger 起点节点时按顶层 trigger.kind 派生（新数据前端已写入）
    const derived = deriveTriggerNode(spec);
    if (derived) spec.nodes = [...(spec.nodes ?? []), derived];
    const checked = validateSpec(spec);
    if (!checked.ok) throw new HttpError(400, "BAD_DAG", "DAG 校验失败：" + checked.errors.join("；"));
```

- [ ] **Step 4: 运行测试确认通过 + handler 级回归**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test engine/trigger.test.js`
Expected: 3 个新用例通过。

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test`
Expected: 全量通过（含 handler 用例；若有 loop.subSpec 含 approval 的触发用例，应返回 400 BAD_DAG）。

- [ ] **Step 5: 提交**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline
git add backend/engine/trigger.js backend/engine/trigger.test.js backend/index.js
git commit -m "feat(index): STEP_TYPES/steps 装配 trigger/branch/join/node；hydrateForRun 为旧数据派生 trigger 起点节点"
```

---

## Task 6: 前端 CodeMirror 依赖 + CodeEditor.vue

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/src/components/CodeEditor.vue`

- [ ] **Step 1: 安装依赖**

Run: `cd frontend && PATH="/usr/local/bin:$PATH" npm install @codemirror/view @codemirror/state @codemirror/lang-javascript @codemirror/basic-setup`
Expected: package.json dependencies 增加四个 @codemirror 包，锁文件更新。

- [ ] **Step 2: 写 CodeEditor.vue（封装 CodeMirror 6，v-model 双向绑定）**

`frontend/src/components/CodeEditor.vue`：

```vue
<template>
  <div ref="host" class="code-editor" :style="{ height: height }"></div>
</template>

<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { EditorView, basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";

const props = defineProps({
  modelValue: { type: String, default: "" },
  height: { type: String, default: "180px" },
});
const emit = defineEmits(["update:modelValue"]);

const host = ref(null);
let view = null;

onMounted(() => {
  view = new EditorView({
    parent: host.value,
    doc: props.modelValue,
    extensions: [basicSetup, javascript(), EditorView.updateListener.of((u) => {
      if (u.docChanged) emit("update:modelValue", u.state.doc.toString());
    })],
  });
});

watch(() => props.modelValue, (v) => {
  if (view && view.state.doc.toString() !== v) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
  }
});

onBeforeUnmount(() => { view?.destroy(); view = null; });
</script>

<style scoped>
.code-editor { border: 1px solid var(--line-strong); border-radius: 10px; overflow: hidden; background: #0d1220; }
.code-editor :deep(.cm-editor) { height: 100%; font-size: 12.5px; }
.code-editor :deep(.cm-scroller) { font-family: var(--font-mono); line-height: 1.6; }
</style>
```

> 注：`codemirror` 汇总包（含 basicSetup）与 `@codemirror/lang-javascript` 直接可用；若 npm 上 `codemirror` 包未随 npm install 安装（仅装了四个 scoped 包），改为 `import { EditorView } from "@codemirror/view"; import { basicSetup } from "codemirror"`——**统一改为安装 `codemirror` 汇总包**：
>
> Run（替代 Step 1）: `cd frontend && PATH="/usr/local/bin:$PATH" npm install codemirror @codemirror/lang-javascript`
> 组件里 `import { EditorView, basicSetup } from "codemirror";` 成立（codemirror 包 re-export basicSetup）。

- [ ] **Step 3: 构建验证**

Run: `cd frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: 构建通过（chunk 体积增加约 400KB 未压缩，属预期）。

- [ ] **Step 4: 提交**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline
git add frontend/package.json frontend/package-lock.json frontend/src/components/CodeEditor.vue
git commit -m "feat(frontend): 新增 CodeEditor.vue（CodeMirror 6 封装，语法高亮/行号/折叠/基础补全）"
```

---

## Task 7: 前端路由 noSidebar + 新建形态（命名 + 触发源 → 保存跳转）

**Files:**
- Modify: `frontend/src/router.js`
- Modify: `frontend/src/App.vue`
- Modify: `frontend/src/pages/PipelineEdit.vue`

- [ ] **Step 1: 写测试（路由 meta）——前端无单测框架，用构建 + 手测清单代替**

本任务无独立单测（项目前端仅构建回归）。**手测清单**（写进提交信息下一条的验证步骤）：
1. 访问 `/pipelines/new`：只显示命名 + 触发源卡片，无画布/节点库/保存栏下方堆叠。
2. 命名 + 选 Webhook → 保存 → 跳转 `/pipelines/:id`，且页面无全局左侧边栏。
3. 从 `/pipelines` 进入既有流水线编辑：无左侧边栏，画布全宽。

- [ ] **Step 2: 路由加 meta.noSidebar**

`frontend/src/router.js`：

```js
  { path: "/pipelines/new", component: () => import("./pages/PipelineEdit.vue") },
  { path: "/pipelines/:id(\\d+)", component: () => import("./pages/PipelineEdit.vue"), meta: { noSidebar: true } },
```

- [ ] **Step 3: App.vue sidebar 按 meta 隐藏**

`frontend/src/App.vue`（script 区加路由引用，模板区加 v-if）：

```vue
<script setup>
import { useRoute } from "vue-router";
const route = useRoute();
</script>

<aside v-if="!route.meta.noSidebar" class="sidebar">
```

- [ ] **Step 4: PipelineEdit.vue 新建形态**

模板在 `<header>` 后、命名栏前加新建形态分支（`v-if="isNew"`），并给现有全部表单区块包 `v-else`（编辑形态）：

```vue
    <!-- 新建形态：命名 + 触发源 → 保存即创建并进入编辑 -->
    <section v-if="isNew" class="create-card card rise" style="animation-delay:.04s">
      <div class="field name-field">
        <label class="field-label">流水线名称</label>
        <input class="input" v-model="current.name" placeholder="如：release-构建-发布" />
      </div>
      <div class="field">
        <label class="field-label">触发源</label>
        <div class="seg-tabs">
          <button type="button" class="seg-tab" :class="{ active: triggerTab === 'manual' }" @click="triggerTab = 'manual'">手动触发</button>
          <button type="button" class="seg-tab" :class="{ active: triggerTab === 'webhook' }" @click="triggerTab = 'webhook'">Webhook 触发</button>
        </div>
      </div>
      <div class="create-actions">
        <button class="btn btn-primary" :disabled="saving" @click="saveAndEdit">
          {{ saving ? "创建中…" : "保存并进入编辑" }}
        </button>
        <button class="btn btn-ghost" @click="back">取消</button>
      </div>
    </section>
```

script 区加 `saveAndEdit`（新建 → 创建 → 跳转编辑页；编辑态复用现有保存逻辑）：

```js
const saveAndEdit = async () => {
  if (!current.value.name.trim()) { notify({ type: "error", message: "请先填写流水线名称" }); return; }
  saving.value = true;
  try {
    const created = await createPipeline(current.value);
    Object.assign(current.value, created);
    notify({ type: "success", message: "已创建流水线，进入编排画布 ✓" });
    router.push(`/pipelines/${created.id}`);
    return true;
  } catch { return false; }
  finally { saving.value = false; }
};
```

- [ ] **Step 5: 构建验证 + 手测清单执行**

Run: `cd frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: 构建通过。按 Step 1 手测清单逐项验证（浏览器 localhost:5174）。

- [ ] **Step 6: 提交**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline
git add frontend/src/router.js frontend/src/App.vue frontend/src/pages/PipelineEdit.vue
git commit -m "feat(frontend): 新建流程拆分（命名+触发源→保存进入编辑）；编辑页路由 meta.noSidebar 隐藏全局侧边栏"
```

---

## Task 8: 前端编辑形态三栏重构（左节点库 / 中画布 / 右悬浮参数浮层 + 变量并入 + 回到原位）

**Files:**
- Modify: `frontend/src/pages/PipelineEdit.vue`

**目标布局（规格 §4）：** 顶部工具栏（返回/名称/自动布局/回到原位/保存）；左栏节点库（可折叠，约 220px）；中区 VueFlow 画布占满；节点参数改为**悬浮浮层**（可拖动/关闭，覆盖画布右上），不选中时无浮层、画布全宽；变量面板并入浮层。

- [ ] **Step 1: 手测清单（先写验收）**

1. 编辑页无左侧全局 sidebar，画布占满。
2. 左栏节点库分组：起点/步骤/控制，拖入或点击追加。
3. 点击节点弹出参数浮层（右上，可拖动、可关闭）；点空白处浮层关闭。
4. 「回到原位」按钮执行 fitView；「自动布局」沿用现有 autoLayout。
5. 浮层内变量面板：显示该节点可用变量（触发参数 ∪ 前驱 outputs），点「插入」落到光标处。

- [ ] **Step 2: 模板重构（三栏容器）**

把现有 `<header>` 保留，命名栏/工具箱/触发卡片/画布/右侧面板的整体包裹改为三栏结构（在模板根部替换）：

```vue
    <!-- 编辑形态：全画布三栏 -->
    <template v-else>
      <header class="topbar">
        <button class="btn btn-ghost" @click="back">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          返回
        </button>
        <span class="topbar-name display">{{ current.name || "未命名流水线" }}</span>
        <span class="topbar-hint muted" v-if="current.id">名称是 Webhook 触发地址的一部分，改名并保存后需重新复制触发地址</span>
        <span class="toolbox-spacer"></span>
        <button class="btn btn-ghost" title="回到原位/适合视角" @click="fitAll">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
          回到原位
        </button>
        <button class="btn btn-ghost" @click="autoLayout">自动布局</button>
        <button class="btn btn-primary" :disabled="saving" @click="save({ stay: true })">
          {{ saving ? "保存中…" : "保存" }}
        </button>
      </header>

      <div class="editor-layout">
        <!-- 左栏：节点库（分组） -->
        <aside class="node-lib">
          <div class="lib-group" v-for="grp in nodeLibGroups" :key="grp.g">
            <span class="mono-tag">{{ grp.g }}</span>
            <button v-for="k in grp.types" :key="k" class="btn node-add" :class="k"
                    draggable="true" :title="NODE_KINDS[k].label + '：点击添加，或拖到画布上指定位置'"
                    @dragstart="onLibDragStart($event, k)" @click="addNode(k)">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="NODE_KINDS[k].icon" /></svg>
              {{ NODE_KINDS[k].label }}
            </button>
          </div>
          <p class="toolbox-hint muted">点击添加，或拖入画布指定位置；节点右侧手柄拖到目标节点左侧手柄建立依赖</p>
        </aside>

        <!-- 中区：画布（占满） -->
        <main class="canvas-zone" @dragover="onCanvasDragOver" @drop="onCanvasDrop">
          <VueFlow
            v-model:nodes="vfNodes"
            v-model:edges="vfEdges"
            :node-types="nodeTypes"
            :min-zoom="0.1"
            fit-view-on-init
            @nodes-change="onNodesChange"
            @edges-change="onEdgesChange"
            @connect="onConnect"
            @node-click="onNodeClick"
            @pane-click="onPaneClick"
          >
            <template #node-dag-node="{ data }">
              <div class="dag-card" :style="{ '--accent-node': NODE_KINDS[data.n.type].accent }">
                <Handle type="target" :position="Position.Left" />
                <div class="cn-ico" :style="{ color: NODE_KINDS[data.n.type].accent }">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="NODE_KINDS[data.n.type].icon" /></svg>
                </div>
                <div class="cn-body">
                  <span class="cn-name mono">{{ NODE_KINDS[data.n.type].label }}</span>
                  <span class="cn-id mono-tag">{{ data.n.id }}</span>
                </div>
                <Handle type="source" :position="Position.Right" />
              </div>
            </template>
            <template #edge-default="{ edge, markerEnd, style }">
              <BaseEdge :path="edgePath(edge)" :marker-end="markerEnd" :style="style" />
              <EdgeLabelRenderer>
                <button v-if="hoverEdgeId === edge.id" class="edge-del"
                        :style="edgeDelStyle(edge)" title="删除连线"
                        @click="removeEdgeByData(edge.data)">
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
                </button>
              </EdgeLabelRenderer>
            </template>
          </VueFlow>
        </main>

        <!-- 悬浮参数浮层：选中节点时显示，可拖动/关闭 -->
        <Transition name="float">
          <div v-if="selected" class="param-float" :style="floatPos" @mousedown.stop>
            <div class="float-head" @mousedown="startFloatDrag">
              <span class="mono-tag">{{ NODE_KINDS[selected.type].label }}</span>
              <button class="float-close" @click="selectedId = ''">✕</button>
            </div>
            <div class="float-body">
              <!-- 节点表单：既有右侧面板内各节点表单迁移至此（shell/sql/approval 原样） -->
              <!-- 变量面板并入：见下方 floatVars 区 -->
              <!-- 既有节点表单（shell/sql/approval 及 T9 新表单）渲染区：原右侧配置面板表单整体迁移至此 -->
            </div>
          </div>
        </Transition>
      </div>
    </template>
```

> **注意**：现有模板的 `#node-dag-node`/`#edge-default` 插槽、`handle` 元素、右侧面板表单（shell/sql/approval）均已存在于当前文件，本任务**移动而非重写**：把右侧配置面板 `<aside class="config-panel">` 整个区域改造成 `param-float` 浮层结构，节点表单 JSX 原样保留。计划不逐行重复既有表单，实施时以「移动 + 包一层浮层容器」为原则，避免 1852 行文件全量重写导致回归。

- [ ] **Step 3: script 区新增：nodeLibGroups / floatPos / 拖拽 / fitAll**

在 `NODE_KINDS` 定义后追加：

```js
const nodeLibGroups = [
  { g: "起点", types: ["trigger"] },
  { g: "步骤", types: ["shell", "sql", "approval", "node"] },
  { g: "控制", types: ["branch", "join", "loop"] },
];
```

> 注意：`trigger` 在 NODE_KINDS 里需补定义（Task 9 统一补全 NODE_KINDS；此处若未定义会渲染 undefined——**Task 8 先补 trigger 一项**）：

```js
const NODE_KINDS = {
  trigger:  { label: "触发起点",   accent: "var(--warn)", icon: "M5 3h14v18l-7-4-7 4z" },
  shell:    { …原样… },
  approval: { …原样… },
  sql:      { …原样… },
};
```

浮层位置与拖动：

```js
const floatPos = ref({ right: "24px", top: "24px" });
let dragState = null;
function startFloatDrag(e) {
  dragState = { dx: e.clientX, dy: e.clientY, right: floatPos.value.right, top: floatPos.value.top };
  window.addEventListener("mousemove", onFloatDrag);
  window.addEventListener("mouseup", stopFloatDrag);
}
function onFloatDrag(e) {
  if (!dragState) return;
  const right = Math.max(8, parseFloat(dragState.right) + (dragState.dx - e.clientX));
  const top = Math.max(8, parseFloat(dragState.top) + (e.clientY - dragState.dy));
  floatPos.value = { right: right + "px", top: top + "px" };
}
function stopFloatDrag() {
  dragState = null;
  window.removeEventListener("mousemove", onFloatDrag);
  window.removeEventListener("mouseup", stopFloatDrag);
}
function fitAll() {
  nextTick(() => { fitView({ padding: 0.2, duration: 250 }).catch(() => {}); });
}
```

变量面板并入浮层：现有 `varGroups(n)` 与「插入变量」下拉已存在；把触发入口（现右侧面板内的 `@focus="onFieldFocus(...)"`）保留，浮层内渲染变量组列表（复用现有模板片段，仅改容器）。

- [ ] **Step 4: 构建验证 + 手测清单执行**

Run: `cd frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: 构建通过。按 Step 1 手测清单逐项验证。

- [ ] **Step 5: 提交**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline
git add frontend/src/pages/PipelineEdit.vue
git commit -m "feat(frontend): 编辑页改三栏布局（左节点库/中画布/右悬浮参数浮层），变量面板并入浮层，新增回到原位 fitAll"
```

---

## Task 9: 新节点表单（branch/join/loop/node）+ Loop 子画布浮层

**Files:**
- Modify: `frontend/src/pages/PipelineEdit.vue`

- [ ] **Step 1: 手测清单**

1. 左栏「控制」组可添加 branch/join/loop 节点；「步骤」组可添加 node 节点。
2. 点击 branch 节点：浮层显示 expr 输入 + cases 列表（value 输入 + 边选择下拉[该节点实际出边] + default 开关 + 增删）。
3. 点击 loop 节点：浮层显示 items 表达式、concurrency、maxIter、「编辑循环体」按钮 → 打开嵌套子画布浮层（独立 VueFlow，可加节点/连边/删边，保存写回 `params.loop.subSpec`）。
4. 点击 node 节点：浮层显示 CodeEditor（脚本）、timeoutSec、maxMemoryMb。
5. 保存后刷新，各新节点参数完整回显。

- [ ] **Step 2: addNode 扩展（默认 params）**

在 `addNode` 的 params 分支补：

```js
      params:
          type === "shell" ? { …原样… }
          : type === "sql" ? { …原样… }
          : type === "node" ? { script: "module.exports = async (env) => ({ ok: true });", timeoutSec: 120, maxMemoryMb: 512 }
          : type === "branch" ? { expr: "${env}", cases: [{ value: "", edge: "" }, { default: true, edge: "" }] }
          : type === "join" ? {}
          : type === "loop" ? { loop: { items: "${items}", subSpec: { nodes: [], edges: [] }, concurrency: 1, maxIter: "", itemVar: "item", indexVar: "index" } }
          : type === "trigger" ? { kind: triggerTab.value === "webhook" ? "webhook" : "manual" }
          : { …原样 approval… },
```

> trigger 节点 kind 取当前新建触发源 tab；编辑态改动 kind 时同步顶层 `spec.trigger.kind`（保持两处一致）。加在 trigger 的 params 变更 watch 里。

- [ ] **Step 3: 新节点表单区块（浮层内）**

浮层 `float-body` 内按 `selected.type` 渲染（沿用现有表单字段风格）：

```vue
      <!-- branch 表单 -->
      <template v-if="selected.type === 'branch'">
        <div class="field">
          <label class="field-label">取值表达式</label>
          <input class="input mono" v-model="selected.params.expr" placeholder="如 ${env}" @focus="onFieldFocus($event, selected, 'expr')" />
          <p class="field-hint">求值结果与各分支 value 精确匹配；未命中走 default 分支。</p>
        </div>
        <div class="field" v-for="(c, i) in selected.params.cases" :key="i">
          <label class="field-label">分支 {{ i + 1 }}<span v-if="c.default">（默认）</span></label>
          <div class="group-row">
            <input class="input mono" v-model="c.value" :disabled="c.default" placeholder="匹配值（default 分支忽略）" />
            <select class="input mono" v-model="c.edge">
              <option value="">— 选择出边 —</option>
              <option v-for="e in outEdgesOf(selected)" :key="e" :value="e">{{ e }}</option>
            </select>
            <button class="btn btn-ghost" @click="toggleDefaultBranch(i)">{{ c.default ? "取消默认" : "设为默认" }}</button>
            <button class="btn btn-ghost" @click="selected.params.cases.splice(i, 1)">删除</button>
          </div>
        </div>
        <button class="btn btn-ghost" @click="selected.params.cases.push({ value: '', edge: '' })">+ 添加分支</button>
      </template>

      <!-- join 表单：无参数 -->
      <template v-else-if="selected.type === 'join'">
        <p class="field-hint">汇聚节点：等待所有前驱完成后继续（前驱输出已进入环境变量，可直接引用）。</p>
      </template>

      <!-- loop 表单 -->
      <template v-else-if="selected.type === 'loop'">
        <div class="field">
          <label class="field-label">迭代列表 items</label>
          <input class="input mono" v-model="selected.params.loop.items" placeholder="如 ${orders}（JSON 数组或逗号分隔）" @focus="onFieldFocus($event, selected, 'loop.items')" />
        </div>
        <div class="group-row">
          <div class="field">
            <label class="field-label">并发迭代数</label>
            <input class="input mono" type="number" min="1" v-model.number="selected.params.loop.concurrency" />
          </div>
          <div class="field">
            <label class="field-label">最大迭代数（留空不限）</label>
            <input class="input mono" type="number" min="1" v-model="selected.params.loop.maxIter" />
          </div>
        </div>
        <button class="btn btn-ghost" @click="openSubCanvas">编辑循环体（子流水线画布）</button>
        <p class="field-hint">子流水线内可使用 sql / 执行脚本等节点（不允许审批与 Shell 回调节点），可嵌套 Loop。</p>
      </template>

      <!-- node 表单 -->
      <template v-else-if="selected.type === 'node'">
        <div class="field">
          <label class="field-label">脚本（Node.js）</label>
          <CodeEditor v-model="selected.params.script" height="220px" />
          <p class="field-hint">函数模式：<code class="mono">module.exports = async (env) => ({...})</code>；或自管 console.log(JSON.stringify({...}))。可读 process.env 与 env 参数。</p>
        </div>
        <div class="group-row">
          <div class="field">
            <label class="field-label">超时（秒）</label>
            <input class="input mono" type="number" min="1" v-model.number="selected.params.timeoutSec" />
          </div>
          <div class="field">
            <label class="field-label">内存上限（MB）</label>
            <input class="input mono" type="number" min="64" v-model.number="selected.params.maxMemoryMb" />
          </div>
        </div>
      </template>
```

script 辅助：

```js
const outEdgesOf = (n) => (spec.value.edges ?? []).filter((e) => e.from === n.id).map((e) => `e${e.from}>${e.to}`);
function toggleDefaultBranch(i) {
  const cases = selected.value?.params?.cases ?? [];
  for (const c of cases) c.default = false;
  cases[i].default = !cases[i].default;
}
```

- [ ] **Step 4: Loop 子画布浮层**

script 区：

```js
const subCanvasOpen = ref(false);
const subCanvasNodes = ref([]);
const subCanvasEdges = ref([]);
function openSubCanvas() {
  const loop = selected.value?.params?.loop;
  if (!loop) return;
  loop.subSpec ??= { nodes: [], edges: [] };
  subCanvasNodes.value = loop.subSpec.nodes.map((n) => ({ id: n.id, position: n.position ?? { x: 60, y: 60 }, data: { n } }));
  subCanvasEdges.value = (loop.subSpec.edges ?? []).map((e) => ({ id: `e${e.from}>${e.to}`, source: e.from, target: e.to }));
  subCanvasOpen.value = true;
}
function closeSubCanvas() {
  const loop = selected.value?.params?.loop;
  if (!loop) return;
  loop.subSpec.nodes = subCanvasNodes.value.map((n) => ({ ...n.data.n, position: n.position }));
  loop.subSpec.edges = subCanvasEdges.value.map((e) => ({ from: e.source, to: e.target }));
  subCanvasOpen.value = false;
}
```

模板（挂在浮层同层、顶层）：独立的第二个 VueFlow，保存回写 `params.loop.subSpec`：

```vue
    <Transition name="float">
      <div v-if="subCanvasOpen" class="sub-canvas">
        <div class="float-head">
          <span class="mono-tag">循环体子流水线</span>
          <button class="float-close" @click="closeSubCanvas">✓ 完成</button>
        </div>
        <VueFlow
          v-model:nodes="subCanvasNodes"
          v-model:edges="subCanvasEdges"
          :node-types="nodeTypes"
          :min-zoom="0.1"
          fit-view-on-init
          @connect="(c) => subCanvasEdges.push({ id: `e${c.source}>${c.target}`, source: c.source, target: c.target })"
        >
          <template #node-dag-node="{ data }">
            <div class="dag-card" :style="{ '--accent-node': NODE_KINDS[data.n.type].accent }">
              <Handle type="target" :position="Position.Left" />
              <div class="cn-ico" :style="{ color: NODE_KINDS[data.n.type].accent }">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="NODE_KINDS[data.n.type].icon" /></svg>
              </div>
              <div class="cn-body">
                <span class="cn-name mono">{{ NODE_KINDS[data.n.type].label }}</span>
                <span class="cn-id mono-tag">{{ data.n.id }}</span>
              </div>
              <Handle type="source" :position="Position.Right" />
            </div>
          </template>
        </VueFlow>
        <p class="toolbox-hint muted">在子画布中添加/连线节点，点「完成」写回循环体。子流水线不允许审批与 Shell 节点。</p>
      </div>
    </Transition>
```

> 子画布节点增删：为控制范围，**子画布支持拖入追加（复用 onCanvasDrop 的 addNode 不适用）**——实施时提供最小「+ 添加节点」按钮（下拉选类型）代替拖拽，避免第二个 DnD 通道复杂度：

```vue
        <div class="sub-toolbar">
          <select class="input mono" v-model="subAddType">
            <option v-for="k in ['sql','node','trigger','branch','join','loop']" :key="k" :value="k">{{ NODE_KINDS[k].label }}</option>
          </select>
          <button class="btn btn-ghost" @click="addSubNode">+ 添加节点</button>
          <button class="btn btn-ghost" @click="autoLayoutSub">自动布局</button>
        </div>
```

```js
const subAddType = ref("sql");
function addSubNode() {
  const id = `s${Date.now()}`;
  subCanvasNodes.value.push({
    id,
    type: "dag-node",
    position: { x: 60 + (subCanvasNodes.value.length % 4) * 220, y: 60 + Math.floor(subCanvasNodes.value.length / 4) * 110 },
    data: { n: { id, type: subAddType.value, params: subAddType.value === "node" ? { script: "module.exports = async (env) => ({ ok: true });" } : subAddType.value === "branch" ? { expr: "${env}", cases: [{ default: true, edge: "" }] } : subAddType.value === "loop" ? { loop: { items: "${items}", subSpec: { nodes: [], edges: [] }, concurrency: 1 } } : {}, name: "", position: null } },
  });
}
```

- [ ] **Step 5: NODE_KINDS 补全（trigger/branch/join/loop/node）**

```js
const NODE_KINDS = {
  trigger:  { label: "触发起点",   accent: "var(--warn)",  icon: "M5 3h14v18l-7-4-7 4z" },
  shell:    { label: "Shell 执行", accent: "var(--accent)", icon: "M4 5l6 7-6 7m8 0h8" },
  approval: { label: "人工审批",   accent: "var(--ember)",  icon: "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6zm-3.5 6.5L11 12l4-4.5" },
  sql:      { label: "SQL 执行",   accent: "var(--accent)", icon: "M4 5h16M7 3l2 2-2 2M12 3l2 2-2 2M7 12H4v3h3zM4 21h7M6 15v6M15 8l5 5M15 13h2a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2h-2" },
  branch:   { label: "条件分支",   accent: "var(--violet, #a78bfa)", icon: "M4 4h7a3 3 0 0 1 3 3v4M14 13v4a3 3 0 0 1-3 3H4m3-16l-2 2 2 2m10 0l2 2-2 2" },
  join:     { label: "合并",       accent: "var(--accent)", icon: "M4 4h7a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H4m0-16H2m2 16H2m16-6h4m-4 0a2 2 0 1 0 4 0 2 2 0 0 0-4 0" },
  loop:     { label: "循环",       accent: "var(--warn)",  icon: "M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4" },
  node:     { label: "执行脚本",   accent: "var(--accent)", icon: "M8 9l-3 3 3 3m8-6l3 3-3 3m-2-8l-4 10" },
};
```

> `var(--violet)` 若未在主题定义会无效——改用既有 token：`branch` 用 `var(--warn)`，`join` 用 `var(--accent)`，`loop` 用 `var(--ember)`，避免引用未定义变量（与 Task 8 的 trigger 定义保持一致口径：trigger 用 `var(--warn)`、loop 用 `var(--ember)`）。

- [ ] **Step 6: 构建验证 + 手测**

Run: `cd frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: 构建通过。按 Step 1 清单手测；保存后刷新验证参数回显；触发执行验证 branch 剪枝与 loop 迭代（用既有执行详情页）。

- [ ] **Step 7: 提交**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline
git add frontend/src/pages/PipelineEdit.vue
git commit -m "feat(frontend): 新增 branch/join/loop/node 节点表单与 Loop 子画布浮层，NODE_KINDS 补全控制节点"
```

---

## Task 10: ExecutionDetail 适配 + 交付前全量回归

**Files:**
- Modify: `frontend/src/pages/ExecutionDetail.vue`

- [ ] **Step 1: 状态映射与 loop 角标**

`frontend/src/pages/ExecutionDetail.vue` 的节点状态色映射（STATUS map）若已含 done/failed/dispatch/wait，补 `skipped`；节点卡片在 `type==="loop"` 且 status==="running" 时显示「迭代中」角标：

```vue
<!-- 节点卡片内（现有 #node-dag-node 模板），status 色 map 补： -->
skipped: 使用 muted 灰（如 var(--text-3)），样式与 done 同构但更淡。
<!-- loop 进行中角标 -->
<span v-if="n.type === 'loop' && (status === 'running' || status === 'dispatch' || status === 'wait')" class="loop-badge">迭代中</span>
```

- [ ] **Step 2: 手测（触发一条含 branch+loop 的流水线）**

1. 后端起服务（或单测覆盖）+ 前端 dev server，新建含 branch/loop 的流水线并手动触发。
2. 执行详情画布：branch 未选分支节点显示「跳过」态；loop 节点完成后显示完成态。
3. 记录区能看到子执行（execId 带 `.it0` 后缀）的节点记录。

- [ ] **Step 3: 全量回归**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test`
Expected: 全部通过。

Run: `cd frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: 构建通过。

- [ ] **Step 4: 提交**

```bash
cd /Users/fengcongyang/Downloads/serverless-pipeline
git add frontend/src/pages/ExecutionDetail.vue
git commit -m "feat(frontend): 执行详情画布适配 skipped 状态与 loop 迭代角标"
```

---

## Self-Review

**1. 规格覆盖核对：**
- §3 页面流程 → T7（新建形态 + noSidebar）。✓
- §4 三栏 + 悬浮浮层 + fitView + 变量并入 → T8。✓
- §5 数据结构（trigger/branch/join/loop/node params）→ T1 校验 + T2/T3 steps + T9 表单。✓
- §6.1 buildGraph/validateSpec（递归 subSpec、禁回调节点、branch cases edge）→ T1。✓
- §6.2 四个 step → T2（trigger/branch/join）+ T3（node）。✓
- §6.3 Loop 递归 + subExecId + concurrency + onError → T4（onError 本期仅 stop，continue 留参数位——已标注）。✓
- §7.1 路由/App.vue → T7。✓
- §7.2 PipelineEdit 两种形态 → T7/T8。✓
- §7.3 CodeEditor → T6。✓
- §7.4 ExecutionDetail → T10。✓
- §8 错误处理（400 BAD_DAG、脚本超时人读）→ T1/T3/T5。✓
- §9 测试策略 → 各任务内嵌测试。✓

**2. 占位符扫描：** 无 TBD/TODO；T3 测试已用修正版（无 NaN 含糊用例）；Task 8 模板中 `<slot-ish />` 已替换为注释说明；Task 4 已删除含糊旧用例，仅保留明确断言版。

**3. 类型一致性：**
- `branchChoices`、`branchChoice`（step 返回）与 T4 实现一致。✓
- `deriveTriggerNode` 在 T5 定义与测试一致。✓
- `NODE_KINDS[k].label/accent/icon` 在 T8/T9 模板引用一致；T9 统一补全。✓
- `outEdgesOf` 返回 `e{from}>{to}` 形态与 T1 validateSpec 的 case.edge 校验形态一致。✓
- `CALLBACK_TYPES`（T1 定义）与 T4 注释引用一致。✓
- 子 execId 形态 `${execId}.it${i}` 在 T4 与 T10 记录归组一致。✓

**4. 已知待实施者注意的坑（已内联）：**
- T4：skipped 并入 done 后，就绪判定必须用「done 剔除 skipped」的副本（doneExec），终态判定用 done（含 skipped）——计划内已给出修正代码。
- T4：失败节点并入 done 防卡死；整执行失败终态用 `snap.failed` 记忆（跨轮）。
- T6：改用 `codemirror` 汇总包 + `@codemirror/lang-javascript`（替代四个 scoped 包方案）。
- T8：不整文件重写，以「移动 + 包浮层」原则改造 1852 行大文件。
