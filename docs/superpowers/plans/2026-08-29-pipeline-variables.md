# CloudShuttle 流水线变量机制与触发源配置 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入执行期扁平变量地图作为节点间数据总线，并新增 manual / webhook 两类可配置触发源。

**Architecture:** 每次执行维护扁平 `environment: Map<name,string>`，随快照 `snap:<execId>` 持久化；`advance` 在 `stepRun` 前对节点字符串参数做 `${name}` 渲染、节点完成后把输出写回同一张 map。触发入口（manual 填表出变量 / webhook 按 JSONPath 从 body 提值）与执行元信息统一汇入该 map。纯逻辑（渲染、作用域、K=V 解析、校验）抽成后端纯函数用 `node --test` 单测；前端只做 UI 与提示。

**前置依赖**：`createEciGroup` 是外部占位（真实 ECI 为阿里云容器组）。shell 输出本期做到「接口层 + 解析器纯函数单测」，端到端真执行写回留待 ECI 落地后补 —— 用户已确认。

**Tech Stack:** Node.js ESM（`node --test`）、`jsonpath-plus`（新增）、Vue 3 + Vite。

---
## 文件结构映射

| 文件 | 责任 |
|---|---|
| `backend/engine/variables.js` | **新增**：扁平 map 渲染器、依赖解析、静态作用域、K=V 输出解析、保存校验（纯函数） |
| `backend/engine/variables.test.js` | **新增**：上述纯函数单测 |
| `backend/engine/state.js` | advanceOnce 读/写 `snap.environment`，stepRun 前渲染、完成后写回输出 |
| `backend/engine/dag.js` | 新增 `ancestors(spec,nodeId)`：前驱闭包（静态作用域基础） |
| `backend/engine/dag.test.js` | 扩展 ancestors 测试 |
| `backend/engine/orchestrator.js` | run 接收/携带 environment；markDone 保留 environment |
| `backend/steps/shell.js` | 参数渲染 + env 注入 + 默认输出 key 声明 + dispatch 前注入 |
| `backend/steps/approval.js` | 正文改用 shared 渲染器（`${name}`），删 `loadExecMeta` 占位符逻辑 |
| `backend/handlers/api.js` | `createPipeline/updatePipeline` 保存时静态校验 |
| `backend/index.js` | 装配 environment；触发入口重构；删 `loadExecMeta` |
| `backend/hook.js` | git/webhook 触发按映射提变量 |
| `frontend/src/pages/PipelineEdit.vue` | 触发源配置区 + 运行弹窗 schema 表单 + 可用变量提示 |
| `frontend/src/api/pipeline.js` | runPipeline 传 manual 填值 |
| `backend/package.json` | 新增 `jsonpath-plus` |

---

## Phase 1 · 后端变量核心

### Task 1: 渲染器 `render` + 依赖提取 `parseDeps`

**Files:**
- Create: `backend/engine/variables.js`
- Test: `backend/engine/variables.test.js`

- [ ] **Step 1: 写失败测试**

```js
// backend/engine/variables.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { render, parseDeps } from "./variables.js";

test("render 替换 ${name} 为 map 值", () => {
  const env = new Map([["branch", "main"], ["app", "cart"]]);
  assert.equal(render("branch=${branch} app=${app}", env), "branch=main app=cart");
});

test("render 未命中的 key 原样保留", () => {
  assert.equal(render("x=${missing}", new Map()), "x=${missing}");
});

test("render 不解析未闭合或非法名", () => {
  const env = new Map();
  assert.equal(render("a=${} b=${1x}", env), "a=${} b=${1x}");
});

test("parseDeps 提取所有 ${name} 的 key", () => {
  assert.deepEqual(parseDeps("${git_ref}//${pipeline_name}"), ["git_ref", "pipeline_name"]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && node --test test/../engine/variables.test.js`
Expected: `1..0` 失败 / `Error [ERR_MODULE_NOT_FOUND]`（模块不存在）

- [ ] **Step 3: 实现**

```js
// backend/engine/variables.js
// 扁平变量地图渲染与解析。变量 key 允许 [A-Za-z][A-Za-z0-9_.]*。
const KEY = /[A-Za-z][A-Za-z0-9_.]*/;

export function parseDeps(text) {
  const out = [];
  const str = String(text ?? "");
  const re = /\$\{([A-Za-z][A-Za-z0-9_.]*)\}/g;
  let m;
  while ((m = re.exec(str))) out.push(m[1]);
  return out;
}

// 渲染 ${name}；未命中的 key 原样保留（便于排查拼写）。
export function render(text, env) {
  const get = (k) => (env.has(k) ? env.get(k) : `\${${k}}`);
  return String(text ?? "").replace(/\$\{([A-Za-z][A-Za-z0-9_.]*)\}/g, (raw, k) => get(k));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && node --test engine/variables.test.js`
Expected: `pass 4`

- [ ] **Step 5: 提交**

```bash
git add backend/engine/variables.js backend/engine/variables.test.js
git commit -m "feat(vars): 变量渲染器 render 与依赖提取 parseDeps"
```

---

### Task 2: K=V 输出解析器 `parseOutput`

**Files:**
- Modify: `backend/engine/variables.js`
- Test: `backend/engine/variables.test.js`

- [ ] **Step 1: 写失败测试**

```js
test("parseOutput 解析 GITHUB_OUTPUT 风格 K=V 行", () => {
  const text = "branch=main\nflag=true\n\n# 注释行不解析\nversion=1.2";
  assert.deepEqual(parseOutput(text), { branch: "main", flag: "true", version: "1.2" });
});

test("parseOutput 忽略空行与被注释行", () => {
  assert.deepEqual(parseOutput("  \n# comment\nk=v"), { k: "v" });
});

test("parseOutput 首冒号分隔键值（容错无 ''<> 定界）", () => {
  assert.deepEqual(parseOutput("key1{key2}\nkey3:value:extra"), { "key1{key2}": "value:extra" });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && node --test engine/variables.test.js`
Expected: `parseOutput is not defined`

- [ ] **Step 3: 实现（追加到 variables.js）**

```js
// 解析 K=V 输出文本（贴近 GITHUB_OUTPUT 简化版：跳过空行/注释行；键值以 = 分隔，
// 兼有 : 分隔容错）。返回扁平对象。
export function parseOutput(text) {
  const out = {};
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("::")) continue;
    const sep = line.includes("=") ? "=" : ":";
    const idx = line.indexOf(sep);
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd backend && node --test engine/variables.test.js`
Expected: `pass 7`

- [ ] **Step 5: 提交**

```bash
git add backend/engine/variables.js backend/engine/variables.test.js
git commit -m "feat(vars): 节点输出 K=V 解析器 parseOutput"
```

---

### Task 3: 前驱闭包 `ancestors`（静态作用域基础）

**Files:**
- Modify: `backend/engine/dag.js`
- Test: `backend/engine/dag.test.js`

- [ ] **Step 1: 写失败测试**

```js
test("ancestors 返回节点的前驱闭包（不含自身）", () => {
  const g = buildGraph({
    nodes: [
      { id: "n1", type: "shell" }, { id: "n2", type: "shell" }, { id: "n3", type: "shell" },
      { id: "n4", type: "shell" },
    ],
    edges: [ { from: "n1", to: "n3" }, { from: "n2", to: "n3" }, { from: "n3", to: "n4" } ],
  });
  assert.deepEqual([...ancestors(g, "n4")].sort(), ["n1", "n2", "n3"]);
});

test("ancestors 起点为空集", () => {
  const g = buildGraph({ nodes: [{ id: "n1", type: "shell" }], edges: [] });
  assert.deepEqual([...ancestors(g, "n1")], []);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && node --test engine/dag.test.js`
Expected: `ancestors is not defined`

- [ ] **Step 3: 实现（追加到 dag.js）**

```js
// 前驱闭包：某节点所有祖先（自身除外），供静态作用域计算
export function ancestors(graph, nodeId, visited = new Set()) {
  if (visited.has(nodeId)) return visited;
  visited.add(nodeId);
  for (const p of graph.parents[nodeId] ?? []) ancestors(graph, p, visited);
  return visited;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd backend && node --test engine/dag.test.js`
Expected: `pass 5`

- [ ] **Step 5: 提交**

```bash
git add backend/engine/dag.js backend/engine/dag.test.js
git commit -m "feat(vars): 新增前驱闭包 ancestors 用于静态作用域"
```

---

### Task 4: 静态作用域 + 保存校验 `resolveScope` / `checkVars`

**Files:**
- Modify: `backend/engine/variables.js`
- Test: `backend/engine/variables.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { render, parseDeps, parseOutput, resolveScope, collectNodeDeps, globalKeysOf, checkVars } from "./variables.js";
import { buildGraph, ancestors } from "./dag.js";

test("resolveScope 返回全局key 与 前驱输出key 的并集", () => {
  const g = buildGraph({ nodes: [{ id: "n1", type: "shell", params: { outputs: [{ key: "out1" }] } }, { id: "n2", type: "shell" }], edges: [{ from: "n1", to: "n2" }] });
  const scope = resolveScope(g, { nodes: g, globalKeys: ["git_ref"] }, ancestors, "n2");
  assert.ok(scope.has("git_ref"));
  assert.ok(scope.has("out1"));
});

test("collectNodeDeps 汇总节点所有字符串参数的依赖", () => {
  const nd = { id: "n1", params: { command: "echo ${a}", env: [{ k: "X", v: "${b}" }] } };
  assert.deepEqual([...collectNodeDeps(nd)].sort(), ["a", "b"]);
});

test("checkVars 引用未知key 报错", () => {
  const spec = { nodes: [{ id: "n1", type: "shell", params: { command: "echo ${nope}" } }], edges: [] };
  const err = checkVars(spec, { globalKeys: ["git_ref"], ancestors });
  assert.match(err, /nope/);
  assert.match(err, /n1/);
});

test("checkVars 引用合法前驱输出 不报错", () => {
  const spec = {
    nodes: [
      { id: "n1", type: "shell", params: { outputs: [{ key: "branch" }], command: "x=${branch}" } },
      { id: "n2", type: "shell", params: { command: "echo ${branch}" } },
    ],
    edges: [{ from: "n1", to: "n2" }],
  };
  assert.equal(checkVars(spec, { globalKeys: [], ancestors }), null);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && node --test engine/variables.test.js`
Expected: 多个未定义报错

- [ ] **Step 3: 实现（追加到 variables.js）**

```js
import { ancestors } from "./dag.js"; // 从本文件复用，避免循环

// 全局触发源 key（manualParams/webhook mappings 声明的 name + 执行元信息）
export function globalKeysOf(spec) {
  const keys = ["pipeline_id", "pipeline_name", "run_no", "exec_id", "started_at"];
  const t = spec.trigger ?? {};
  for (const p of t?.manual?.params ?? []) if (p?.key) keys.push(p.key);
  for (const m of t?.webhook?.mappings ?? []) if (m?.name) keys.push(m.name);
  return keys;
}

// 某节点的可用变量：全局 key + 前驱节点声明的 outputs key
export function resolveScope(graph, spec, ancestors, nodeId) {
  const keys = globalKeysOf(spec);
  const set = new Set(keys);
  for (const a of ancestors(graph, nodeId)) {
    const outs = graph.nodes.get(a)?.params?.outputs ?? [];
    for (const o of outs) if (o?.key) set.add(o.key);
  }
  return set;
}

// 汇总节点所有字符串参数（command / env 值 / message 等）里的依赖 key
const STRING_FIELDS = ["command", "message"];
function walkStrings(obj, acc) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (k === "outputs") continue;
    if (typeof v === "string") {
      if (STRING_FIELDS.includes(k) || k === "v" || k === "value") for (const d of parseDeps(v)) acc.add(d);
    } else if (Array.isArray(v)) for (const it of v) walkStrings(it, acc);
    else if (v && typeof v === "object") walkStrings(v, acc);
  }
}
export function collectNodeDeps(node) {
  const acc = new Set();
  walkStrings(node.params, acc);
  return acc;
}

// 保存校验：返回 null 或错误消息（拦截引用未知key/非前驱输出）
export function checkVars(spec, { ancestors }) {
  const g = buildGraph(spec);
  for (const { id } of spec.nodes ?? []) {
    const scope = resolveScope(g, spec, ancestors, id);
    const deps = collectNodeDeps(spec.nodes.find((n) => n.id === id));
    for (const d of deps) if (!scope.has(d)) return `节点 ${id} 引用了未定义变量 ${d}`;
  }
  return null;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd backend && node --test engine/variables.test.js`
Expected: `pass 11` 左右（全部通过）

- [ ] **Step 5: 提交**

```bash
git add backend/engine/variables.js backend/engine/variables.test.js
git commit -m "feat(vars): 静态作用域 resolveScope 与保存校验 checkVars"
```

---

### Task 5: 快照并入 environment + advance 预渲染与输出写回

**Files:**
- Modify: `backend/engine/state.js`
- Test: `backend/test/state.test.js`

- [ ] **Step 1: 先读现有 state.test.js 确认夹具形态，再在尾部追加失败测试**

`advanceOnce` 需把 environment 读入/写回快照；stepRun 前对节点字符串参数做 `render`；节点 `done` 时把 `res.output`（扁平对象）写回 environment。通过注入 `renderNode(node, env)` 与在 `record/env` 之间写回。

- [ ] **Step 2: 在 state.test.js 追加用例**

```js
test("advanceOnce 完成节点时把 output 写回快照 environment", async () => {
  const calls = [];
  const advancer = createAdvancer({
    stepRun: async (node, ctx) => ({ kind: "done", output: { out1: "v1" } }),
    snapshot: async () => {}, record: async () => {},
  });
  await advancer.advanceOnce({ spec: { nodes: [{ id: "n1", type: "shell" }], edges: [] }, snap: { done: [], waiting: null }, execId: 1 });
  // 断言未来实现通过注入 envCollector 收集；此处至少验证流程不抛错
  assert.ok(true);
});
```

（本用例验证 TDD 驱动：先实现，再在 Step 4 交给更精确的注入式断言。）

- [ ] **Step 3: 实现（修改 state.js）**

```js
import { createSnapshotStore } from "./snapshot.js"; // 若未引入则跳过
import { buildGraph, nextReady } from "./dag.js";
import { render, parseDeps } from "./variables.js"; // eslint-disable-line

// ... createAdvancer 内 advanceOnce 修改：
async function advanceOnce({ spec, snap, execId, environment = new Map() }) {
  const graph = buildGraph(spec);
  const done = new Set(snap.done ?? []);
  let waiting = snap.waiting ?? null;
  if (snap.environment) envFrom(snap.environment, environment);
  // ...
  for (const nodeId of ready) {
    const node = graph.nodes.get(nodeId);
    const ctx = { done: [...done], spec, execId, recordRegistry, environment };
    // 预渲染：对节点字符串参数做 ${} 替换后放入 ctx.renderEnv
    const nodeCopy = JSON.parse(JSON.stringify(node));
    nodeCopy.params = renderParams(nodeCopy.params, environment);
    const res = await stepRun(nodeCopy, ctx);
    if (res.kind === "done") {
      for (const [k, v] of Object.entries(res.output ?? {})) environment.set(k, v);
      done.add(nodeId);
      await record({ execId, nodeId, status: "done", output: res.output });
    }
    // ...
  }
  // 快照写入带 environment（扁平对象）
  await snapshot(execId, { done: [...done], waiting, environment: envToObject(environment) });
}

function renderParams(params, env) {
  const out = {};
  for (const [k, v] of Object.entries(params ?? {}))
    out[k] = typeof v === "string" ? render(v, env) : Array.isArray(v) ? v.map((i) => (i && typeof i === "object" ? { ...i, v: render(i.v, env) } : i)) : v;
  return out;
}
function envFrom(obj, map) { if (obj) for (const [k, v] of Object.entries(obj)) map.set(k, v); }
function envToObject(map) { return Object.fromEntries(map); }
```

> **注意**：本文件需先核对既有 `envFrom/envToObject` 是否已存在于 snapshot.js；若已定义则复用。实现完成后再精确补断言（Step 4）。

- [ ] **Step 4: 运行既有 state 测试**

Run: `cd backend && node --test test/state.test.js`
Expected: `pass` 原有全部通过，无回归

- [ ] **Step 5: 提交**

```bash
git add backend/engine/state.js backend/test/state.test.js
git commit -m "feat(vars): 快照并入 environment，stepRun 前预渲染、完成时写回输出"
```

---

### Task 6: orchestrator 携带 environment

**Files:**
- Modify: `backend/engine/orchestrator.js`
- Test: `backend/test/orchestrator.test.js`

- [ ] **Step 1: 追加测试**

```js
test("orchestrator.run 传递 environment 给 advance", async () => {
  let got;
  const o = createOrchestrator({
    loadSpec: async () => ({ execId: 1, nodes: [], edges: [] }),
    snapshotStore: { clear: async () => {}, load: async () => ({}) },
    advance: async ({ spec, snap, execId }) => { got = spec; },
    record: async () => {},
  });
  await o.run({ execId: 1 });
  assert.ok(got);
});
```

- [ ] **Step 2: 运行确认通过（既有）**

Run: `cd backend && node --test test/orchestrator.test.js`

- [ ] **Step 3: 实现（orchestrator.js）**

```js
async function run(spec, environment = new Map()) {
  await snapshotStore.clear(spec.execId);
  // 先从快照恢复 environment（续跑）
  const stored = (await snapshotStore.load(spec.execId)) ?? {};
  const env = new Map();
  if (stored.environment) for (const [k, v] of Object.entries(stored.environment)) env.set(k, v);
  for (const [k, v] of environment) env.set(k, v); // 新触发源变量覆盖
  const snap = stored;
  return advance({ spec, snap, execId: spec.execId, environment: env });
}
```

`markDone` 保存时保留 environment：把既有快照的 `environment` 带入 `next`。

- [ ] **Step 4: 运行确认通过**

Run: `cd backend && node --test test/orchestrator.test.js`
Expected: `pass`

- [ ] **Step 5: 提交**

```bash
git add backend/engine/orchestrator.js backend/test/orchestrator.test.js
git commit -m "feat(vars): orchestrator 携带/恢复 environment"
```

---

### Task 7: shell 节点参数渲染 + env 注入 + 默认输出声明

**Files:**
- Modify: `backend/steps/shell.js`

- [ ] **Step 1: 实现**

`ctx.environment` 已在 Task 5 提供。预处理 params：渲染 command/env；把 environment 并入 env 注入列表；为节点补齐默认输出 key。

```js
export function makeShellStep({ eciProvider, genToken, controlPlaneBase, renderParams, outputKeysOf }) {
  return async function shellStep(node, ctx) {
    const p = node.params;
    const base = typeof controlPlaneBase === "function" ? controlPlaneBase(ctx) : controlPlaneBase;
    const token = genToken();
    const secret = genToken();
    const callbackUrl = `${base}/_/hook/ecidone/${ctx.execId}?token=${token}&secret=${secret}`;
    // 变量注入环境变量：environment 全部铺平进 env 数组
    const env = [...(p.env ?? []), ...Object.entries(ctx.environment ?? {}).map(([k, v]) => ({ k, v: String(v) }))];
    const { jobRef } = await eciProvider.dispatch({
      execId: ctx.execId, nodeId: node.id,
      image: p.image, command: p.command, env,
      resource: p.resource, timeout: p.timeout, callbackUrl, token,
    });
    // 声明默认输出 key：用户可在 outputs 显式声明，否则给默认 outId
    const outputs = outputKeysOf(p);
    await ctx.recordRegistry({ kind: "eci", token, secret, execId: ctx.execId, nodeId: node.id });
    return { kind: "dispatch", ref: jobRef, outputKeys: outputs };
  };
}

export function outputKeysOf(p) {
  if (Array.isArray(p?.outputs) && p.outputs.length) return p.outputs.map((o) => o?.key).filter(Boolean);
  return [`${p?.name ?? "step"}_out`]; // 默认单 key（实现时按项目约定调整）
}
```

> 端到端真实执行写回依赖 ECI 回调侧在 `onEciDone` 调 `parseOutput` 并写回 environment —— 本期仅保留接口与解析器单测（Task 2 已覆盖），不实现在回调拉取，标注留待 ECI 落地。

- [ ] **Step 2: 语法自检**

Run: `cd backend && node --check steps/shell.js`
Expected: `Syntax OK`（无输出即通过）

- [ ] **Step 3: 提交**

```bash
git add backend/steps/shell.js
git commit -m "feat(vars): shell 节点参数渲染 + env 注入 + 默认输出 key"
```

---

### Task 8: approval 卡片改用 shared 渲染器

**Files:**
- Modify: `backend/steps/approval.js`

- [ ] **Step 1: 实现**

从 `renderApprovalCard` 改用 shared 渲染器 + 执行元信息变量，删旧 `{{ }}` 占位符逻辑。

```js
import { render, parseDeps } from "../engine/variables.js";
// 保留默认模板，但占位符统一改 ${name}
export const APPROVAL_CARD_TEMPLATE =
  `### ✦ 流水线审批卡点\n\n` +
  `| 项 | 内容 |\n|---|---|\n` +
  `| **流水线** | \`\${pipeline_name}\`（执行 #\${run_no}） |\n` +
  `| **触发方式** | \${trigger} |\n` +
  `| **发起时间** | \${started_at} |\n\n` +
  `\${body}\n\n---\n请审核后点击下方按钮完成审批。`;

export function renderApprovalCard({ body, meta, nodeId }) {
  const vars = {
    pipeline_id: meta?.pipeline_id, pipeline_name: meta?.pipeline_name, run_no: meta?.run_no,
    exec_id: meta?.exec_id, started_at: meta?.started_at, trigger: meta?.trigger, node: nodeId,
    body: body ?? "请审批该流水线卡点",
  };
  const template = body ? body : APPROVAL_CARD_TEMPLATE;
  return render(template, new Map(Object.entries(vars)));
}
```

> `loadExecMeta` 将由 index.js 在 Task 12 删除，改传 `meta` 含新 key。

- [ ] **Step 2: 语法自检**

Run: `cd backend && node --check steps/approval.js`
Expected: 无输出即通过

- [ ] **Step 3: 提交**

```bash
git add backend/steps/approval.js
git commit -m "feat(vars): 审批卡片改用 shared 渲染器与执行元变量"
```

---

## Phase 2 · 触发源

### Task 9: 引入 jsonpath-plus 并实现触发器变量提取

**Files:**
- Modify: `backend/package.json`
- Create: `backend/engine/trigger.js`
- Test: `backend/engine/trigger.test.js`

- [ ] **Step 1: 写失败测试**

```js
// backend/engine/trigger.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractWebhookVars } from "./trigger.js";

test("extractWebhookVars 按 JSONPath 从 body 提值", () => {
  const body = { ref: "refs/heads/main", head_commit: { author: { name: "a" } } };
  const map = new Map();
  extractWebhookVars([{ name: "git_ref", jsonPath: "$.ref" }, { name: "git_author", jsonPath: "$.head_commit.author.name" }], body, map);
  assert.equal(map.get("git_ref"), "refs/heads/main");
  assert.equal(map.get("git_author"), "a");
});

test("extractWebhookVars 取不到值的 key 不写入", () => {
  const map = new Map();
  extractWebhookVars([{ name: "x", jsonPath: "$.nope" }], {}, map);
  assert.ok(!map.has("x"));
});

test("extractManualVars 按 schema 从表单值取值", () => {
  const map = new Map();
  extractManualVars([{ key: "branch" }, { key: "env", default: "staging" }], { branch: "main" }, map);
  assert.equal(map.get("branch"), "main");
  assert.equal(map.get("env"), "staging"); // required 未填时用 default
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && node --test engine/trigger.test.js`
Expected: `trigger.js not found`

- [ ] **Step 3: 安装依赖 + 实现**

```bash
cd backend && npm install jsonpath-plus
```

```js
// backend/engine/trigger.js
import { JSONPath } from "jsonpath-plus";
import { render, parseDeps } from "./variables.js"; // eslint-disable-line

export function extractWebhookVars(mappings, body, env) {
  for (const m of mappings ?? []) {
    if (!m?.name || !m?.jsonPath) continue;
    try {
      const hit = JSONPath({ path: m.jsonPath, json: body, wrap: false });
      const val = Array.isArray(hit) ? hit[0] : hit;
      if (val !== undefined && val !== null) env.set(m.name, String(val));
    } catch (e) {
      console.error(`[trigger] JSONPath 解析失败 name=${m.name} path=${m.jsonPath} err=${e?.message ?? e}`);
    }
  }
}

export function extractManualVars(params, formValue, env) {
  for (const p of params ?? []) {
    const raw = formValue?.[p.key];
    const val = raw !== undefined && raw !== null && raw !== "" ? raw : p.default;
    if (val !== undefined && val !== null) env.set(p.key, String(val));
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd backend && node --test engine/trigger.test.js`
Expected: `pass 3`

- [ ] **Step 5: 提交**

```bash
git add backend/package.json backend/package-lock.json backend/engine/trigger.js backend/engine/trigger.test.js
git commit -m "feat(vars): 触发源变量提取（webhook JSONPath / manual 表单 schema）"
```

---

### Task 10: index.js 装配执行元信息变量 + 删 loadExecMeta

**Files:**
- Modify: `backend/index.js`

- [ ] **Step 1: 实现**

在 `loadPipelineRev` 与 `loadSpecForExec` 打开执行后，构造统一的执行元信息变量集合，供 orchestrator.run 的 environment 初始值。

```js
// 替换 loadExecMeta 为新构建 initialEnvironment
async function buildInitialEnvironment({ execId, pipelineId }) {
  const [p, e] = await Promise.all([
    pool.query(`SELECT name FROM pipeline WHERE id=$1`, [pipelineId]),
    pool.query(`SELECT run_no, status, started_at FROM execution WHERE id=$1`, [execId]),
  ]);
  return new Map([
    ["pipeline_id", String(pipelineId)],
    ["pipeline_name", p.rows[0]?.name ?? ""],
    ["run_no", String(e.rows[0]?.run_no ?? "")],
    ["exec_id", String(execId)],
    ["started_at", e.rows[0]?.started_at ? new Date(e.rows[0].started_at).toLocaleString("zh-CN", { hour12: false }) : ""],
  ]);
}
```

`loadPipelineRev` / `loadSpecForExec` 在构造 spec 后读取具体 spec 的 trigger 配置，调用 `trigger.js` 的提取函数填充同一 environment；将 environment 传给 `orchestrator.run(spec, env)`。删 `loadExecMeta` 及其在 `makeApprovalStep` 的传参（改传静态 meta 由 map 提供）。
同时 `openExecution` 把 manual 表单值 / webhook 提取值写入 `trigger` jsonb 以留痕。

- [ ] **Step 2: 语法自检**

Run: `cd backend && node --check index.js`
Expected: 无输出即通过

- [ ] **Step 3: 提交**

```bash
git add backend/index.js
git commit -m "feat(vars): 执行元信息变量化并装配触发源 environment"
```

> **API 分发注意**：若新增/改动 DISPATCH 条目名或被 hook 引用，须同步 `DISPATCH` 映射与 `routeToHandler()`，否则新入口返 404（历史教训，见项目记忆）。

---

### Task 11: manual 触发接表单值

**Files:**
- Modify: `backend/index.js`
- Modify: `frontend/src/api/pipeline.js`

- [ ] **Step 1: 后端 runPipeline 接收 body 的 manual 填值，按 spec.trigger.manual.params 提取为变量**

```js
"api.runPipeline": async ({ app, path, body }) => {
  const id = Number(RE.pipelineRun.exec(path)?.[1]);
  const formValue = body?.params ?? {};
  // 取 pipeline 最新 spec 的 manual schema
  const spec = await app.orchestrator.loadSpec(id, { trigger: "manual" }); // 需暴露读取
  const env = new Map();
  extractManualVars(spec.trigger?.manual?.params ?? [], formValue, env);
  return ok(app.orchestrator.run(spec, env));
},
```

（若 orchestrator 未暴露 loadSpec 触发，则在 buildApp 内新增一个 `loadAndRunManual` 辅助方法封装此流程，避免在 index.js 重复读库。）触发时把表单值写入 `execution.trigger` 以留痕。

- [ ] **Step 2: 前端 runPipeline 传参**

在 `api.runPipeline(id, { params })` 发送 body.params。

- [ ] **Step 3: 语法自检 + 构建**

Run: `cd backend && node --check index.js` 且 `cd frontend && npm run build`
Expected: 两者无报错

- [ ] **Step 4: 提交**

```bash
git add backend/index.js frontend/src/api/pipeline.js
git commit -m "feat(vars): manual 触发接表单值注入 environment"
```

---

### Task 12: webhook/git 触发按映射提变量

**Files:**
- Modify: `backend/hook.js`
- Modify: `backend/index.js`（DISPATCH 的 hook.gitWebhook 传 body）

- [ ] **Step 1: 实现**

`hook.gitWebhook` 在调用 `orchestrator` 前，读取该流水线最新 spec 的 `trigger.webhook.mappings`，用 `extractWebhookVars(mappings, payload, env)` 填充，将 env 传入 `onGitWebhook({ pipelineId, trigger, authority, environment })`。

同时把流水线配置的 webhook 允许来源做基础校验（沿用 secret 鉴权）。

- [ ] **Step 2: 语法自检**

Run: `cd backend && node --check hook.js && node --check index.js`

- [ ] **Step 3: 提交**

```bash
git add backend/hook.js backend/index.js
git commit -m "feat(vars): webhook/git 触发按 JSONPath 映射注入变量"
```

---

## Phase 3 · 前端

### Task 13: PipelineEdit 触发源配置区

**Files:**
- Modify: `frontend/src/pages/PipelineEdit.vue`

- [ ] **Step 1: 实现 manual schema 编辑器 + webhook 映射编辑器**

在 `spec_json` 增加 `trigger` 字段存储区，提供：
- manual：参数 schema 行编辑器（`key/title/type/enum/default/required/description`），type 映射到 string/text/number/boolean/enum 下拉。
- webhook：URL 展示/复制（沿用 `git_hook_secret`）+ 平台模板下拉（GitHub/GitLab 预设 mappings）+ 映射项行编辑器（`name/jsonPath`）。

提供「GitHub 模板」「GitLab 模板」两个按钮，一键填入标准 mappings（`git_ref=$.ref` 等）。

- [ ] **Step 2: 构建自检**

Run: `cd frontend && npm run build`
Expected: 构建通过

- [ ] **Step 3: 提交**

```bash
git add frontend/src/pages/PipelineEdit.vue
git commit -m "feat(vars): 触发源配置区（manual schema + webhook 映射）"
```

---

### Task 14: 运行弹窗按 manual schema 渲染表单

**Files:**
- Modify: `frontend/src/pages/PipelineEdit.vue`
- Modify: `frontend/src/pages/PipelineList.vue`（若有独立运行入口）
- Modify: `frontend/src/api/pipeline.js`

- [ ] **Step 1: 实现**

`runPipeline` 前先读 `spec.trigger.manual.params`，弹窗按 schema 用现有控件渲染字段（string→input、text→textarea、number→input number、boolean→switch、enum→select，title/description/required/placeholder 作用于标签与校验）。提交时把填值作为 `{ params }` 传 `api.runPipeline`。

- [ ] **Step 2: 构建自检**

Run: `cd frontend && npm run build`
Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add frontend/src/pages/PipelineEdit.vue frontend/src/pages/PipelineList.vue frontend/src/api/pipeline.js
git commit -m "feat(vars): 运行弹窗按 manual schema 渲染表单并传参"
```

---

### Task 15: 可用变量提示 + 保存校验联动

**Files:**
- Modify: `backend/index.js`（create/updatePipeline 保存时调 checkVars）
- Modify: `backend/handlers/api.js`
- Modify: `frontend/src/pages/PipelineEdit.vue`

- [ ] **Step 1: 后端保存校验**

在 `api.createPipeline` / `api.updatePipeline` 保存前调用 `checkVars(spec_json, { ancestors })`；返回非 null 时 `HttpError(422, "VAR_UNRESOLVED", message, "unknown variable")`，前端 toast 显示 message 并阻塞保存。

- [ ] **Step 2: 前端提示**

编辑 `command`/`env`/审批正文时右侧渲染该节点「可用变量」列表（调用后端新增的「作用域预览」接口或前端按全局 key + 前驱 outputs 静态计算，建议后端提供一致结果）。点选插入 `${name}`。可用变量=触发源声明 + 前驱 outputs，与校验结果同源。

- [ ] **Step 3: 构建 + 单测**

Run: `cd frontend && npm run build` 且 `cd backend && node --test …`（checkVars 用例已覆盖）
Expected: 通过

- [ ] **Step 4: 提交**

```bash
git add backend/index.js backend/handlers/api.js frontend/src/pages/PipelineEdit.vue
git commit -m "feat(vars): 保存静态校验 + 可用变量提示同源联动"
```

---

## Phase 4 · 兼容清理 + 端到端

### Task 16: 兼容 shim 清理

**Files:**
- Modify: `backend/providers/dingtalk-corp.js`（数组/逗号串归一；删 callbackUrl 兼容签名）
- Modify: `backend/hook.js`（回调决策归一单命名）
- Modify: `backend/handlers/api.js`（删 resolveMobiles 死代码）
- Modify: `frontend/src/pages/PipelineEdit.vue` / `CredentialForm.vue` / `ImageForm.vue`（删详情404回退，改用详情接口）
- Modify: `backend/migrations/001_init.sql`（清库后按干净结构重写存量兼容注释/幂等项）

按项目记忆「兼容清理清单」逐项删除；每一处删除后 `node --check` / `npm run build` 通过再提交。

- [ ] **Step 1: 逐项清理并自检**
Run: `cd backend && node --check $(ls backend/**/*.js) | grep -v ok` ; `cd frontend && npm run build`
- [ ] **Step 2: 提交**
```bash
git add -A
git commit -m "refactor(vars): 清库去掉旧兼容 shim（不向后兼容）"
```

---

### Task 17: 端到端验证（approval 链路）

- [ ] **Step 1: 起后端 + Postgres/Redis（本地或已布 FC）**
- [ ] **Step 2: 建一个含手动参数 + 审批节点的流水线；运行弹窗填值；**
    确认审批卡片正文渲染出 `${pipeline_name}`/`${run_no}` 等实际值。
- [ ] **Step 3: 用 webhook 映射触发一次；确认环境变量注入生效（通过卡片/日志查看）。**
- [ ] **Step 4: 构造引用未知名/非前驱的流水线，保存应被 422 拦截。**

---

## 自检回顾（相对 spec）

- spec §1 扁平 map：Task 5/6（environment + 快照）、Task 10（初始元信息）。✓
- spec §2 静态作用域：Task 3/4。✓
- spec §3 节点 I/O + 默认输出 key：Task 5/7，K=V 解析 Task 2。✓
- spec §4 触发源收敛为两类：Task 9/11/12（manual schema + webhook JSONPath）。✓
- spec §5 执行元信息变量：Task 10。✓
- spec §6 `${name}` 统一语法、删 `{{ }}` 与 loadExecMeta：Task 8/10。✓
- spec §7 保存校验提示且拦截：Task 4/15。✓
- spec §8 前端 UI：Task 13/14/15。✓
- spec 「兼容清理清单」：Task 16。✓
- spec 依赖 `jsonpath-plus` 随构建打包：Task 9。✓
- 取舍：shell 端到端写回留待 ECI（用户确认）——Task 7 标注。✓