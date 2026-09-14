# 流水线编辑页全画布重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把流水线新建/编辑页重构为全画布编辑器：隐藏全局侧栏、名称标题内联编辑、触发源变画布节点（默认一个、锁定）、画布撑满、节点参数改悬浮浮窗、节点库改左侧边栏。

**Architecture:** 后端仅加 no-op `trigger` step（`STEP_TYPES` + `steps` 双注册，防漂移检查两端同步）；`spec.trigger.params` 顶层读取点不动。前端 `PipelineEdit.vue` 模板重排为 topbar + 左节点库 + 画布 + 悬浮浮窗四块，script 逻辑大部分保留（selected/onNodesChange/addNode/变量插入/Webhook 会话等），路由加 `meta.noSidebar`，App.vue 按 meta 隐藏侧栏并去掉主区内边距。

**Tech Stack:** Vue 3 + VueFlow（@vue-flow/core）+ vite；后端 Node ESM（node:test）；测试命令 `cd backend && PATH="/usr/local/bin:$PATH" node --test`、`cd frontend && PATH="/usr/local/bin:$PATH" npm run build`。

**规格文档：** `docs/superpowers/specs/2026-09-14-pipeline-edit-canvas-design.md`

---

## 文件结构总览

| 文件 | 责任 | 任务 |
|---|---|---|
| `backend/steps/trigger.js`（新） | no-op trigger step | T1 |
| `backend/steps/trigger.test.js`（新） | step 单测 | T1 |
| `backend/index.js` | STEP_TYPES/steps 装配 trigger | T1 |
| `frontend/src/router.js` | `/pipelines/new`、`/pipelines/:id` 加 meta.noSidebar | T2 |
| `frontend/src/App.vue` | sidebar 按 meta 隐藏；main--bare 去内边距 | T2 |
| `frontend/src/pages/PipelineEdit.vue` | topbar/节点库/画布/浮窗重排 + 名称编辑 + 触发节点 | T3/T4 |

**交互约定（跨任务一致）：**
- 触发节点：`type:"trigger"`、`params.kind` ∈ `manual|webhook`、锁定不可删、只允许作为出边起点（禁止 `to===triggerId`）。
- 触发参数 schema 仍存顶层 `spec.trigger.params`（后端读取点），trigger 节点只存 kind。
- 名称默认「未命名流水线」；标题内联编辑，Enter/失焦提交、Esc 取消。
- 保存按钮 stay 模式（不跳列表）；「返回列表」在 topbar 最左。
- 浮窗 `position:fixed`，top/right 记录拖动，`v-if="selected"` 渲染，点画布空白关闭。

---

## Task 1: 后端 no-op trigger step + 双注册

**Files:**
- Create: `backend/steps/trigger.js`、`backend/steps/trigger.test.js`
- Modify: `backend/index.js`（import 区 + STEP_TYPES + steps 装配）

- [ ] **Step 1: 写失败测试**

`backend/steps/trigger.test.js`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { makeTriggerStep } from "./trigger.js";

test("trigger step 返回 done 且输出为空（触发变量已由 hydrateForRun 注入 environment）", async () => {
  const step = makeTriggerStep();
  const node = { id: "t1", type: "trigger", kind: "manual", params: {} };
  const res = await step(node, { environment: new Map([["foo", "1"]]) });
  assert.deepEqual(res, { kind: "done", output: {} });
});

test("trigger step 与节点 kind 无关（manual/webhook 同属 no-op）", async () => {
  const step = makeTriggerStep();
  const web = await step({ id: "t2", type: "trigger", kind: "webhook", params: {} }, { environment: new Map() });
  assert.equal(web.kind, "done");
  assert.deepEqual(web.output, {});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test steps/trigger.test.js`
Expected: `Cannot find module './trigger.js'`（文件不存在）。

- [ ] **Step 3: 实现 makeTriggerStep**

`backend/steps/trigger.js`：

```js
// trigger 起点节点：触发变量（manual 表单值 / webhook 载荷）已由 hydrateForRun 的
// assembleTriggerEnv 注入执行环境，节点本身无副作用、无输出，仅作为 DAG 起点标记。
export function makeTriggerStep() {
  return async function triggerStep() {
    return { kind: "done", output: {} };
  };
}
```

修改 `backend/index.js` 三处：

1) import 区（现有 `steps/*` import 附近，约第 19 行 `import { makeSqlStep } ...` 行）：

```js
import { makeTriggerStep } from "./steps/trigger.js";
```

2) `export const STEP_TYPES = ["shell", "approval", "sql"];`（第 266 行）改为：

```js
export const STEP_TYPES = ["trigger", "shell", "approval", "sql"];
```

3) `steps` 装配对象（第 346-356 行，`sql: makeSqlStep({...})` 后加一项）：

```js
  const steps = {
    trigger: makeTriggerStep(),
    shell: makeShellStep({
      eciProvider, genToken: randomUUID, controlPlaneBase: resolveControlBase,
      getEci: getEciConfig,
    }),
    approval: makeApprovalStep({
      dingtalkCorpProvider, getCredentialKind, getCredentialSecrets,
      genToken: randomUUID, controlPlaneBase: resolveControlBase,
    }),
    sql: makeSqlStep({ getCredentialKind, getCredentialSecrets, createConnection: createDbConnection }),
  };
```

（`steps` 对象的其余原始内容保留；防漂移 for 循环自动覆盖新类型。）

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test steps/trigger.test.js`
Expected: 2 个用例通过。

- [ ] **Step 5: 全量回归 + 提交**

Run: `cd backend && PATH="/usr/local/bin:$PATH" node --test`
Expected: 全部通过（无回归；STEP_TYPES 新增未破坏防漂移检查）。

```bash
cd /workspace
git add backend/steps/trigger.js backend/steps/trigger.test.js backend/index.js
git -c user.name="spencerswagger" -c user.email="devcloud@fcy.zj.cn" commit -m "feat(engine): 新增 no-op trigger step 并注册 STEP_TYPES（触发源画布节点执行支持）"
```

---

## Task 2: 路由 meta.noSidebar + App.vue 隐藏侧栏

**Files:**
- Modify: `frontend/src/router.js`
- Modify: `frontend/src/App.vue`

- [ ] **Step 1: 路由加 meta**

`frontend/src/router.js` 两条流水线编辑路由改为：

```js
  { path: "/pipelines", component: () => import("./pages/PipelineList.vue") },
  { path: "/pipelines/new", component: () => import("./pages/PipelineEdit.vue"), meta: { noSidebar: true } },
  { path: "/pipelines/:id(\\d+)", component: () => import("./pages/PipelineEdit.vue"), meta: { noSidebar: true } },
```

- [ ] **Step 2: App.vue 按 meta 隐藏侧栏 + 主区去内边距**

`frontend/src/App.vue` script 区加路由引用（现有 `import { toasts } ...` 上方）：

```js
import { useRoute } from "vue-router";
const route = useRoute();
```

模板 `aside` 与 `main` 加条件/类：

```html
    <aside v-if="!route.meta.noSidebar" class="sidebar">
```

```html
    <main class="main" :class="{ 'main--bare': route.meta.noSidebar }">
```

样式 `.main` 后追加：

```css
.main--bare { padding: 0; overflow: hidden; }
```

- [ ] **Step 3: 构建 + 手测**

Run: `cd frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: 构建通过。

手测：打开 `/pipelines/new` 与任一 `/pipelines/:id`，无左侧边栏且主区无内边距；其他路由（/pipelines、/credentials、/images、/executions）侧栏与内边距照旧。

- [ ] **Step 4: 提交**

```bash
cd /workspace
git add frontend/src/router.js frontend/src/App.vue
git -c user.name="spencerswagger" -c user.email="devcloud@fcy.zj.cn" commit -m "feat(frontend): 流水线编辑页路由 meta.noSidebar 隐藏全局侧栏并铺满主区"
```

---

## Task 3: PipelineEdit script 改造（触发节点 / 名称编辑 / 浮窗状态 / 锁定守卫）

**Files:**
- Modify: `frontend/src/pages/PipelineEdit.vue`

原则：script 区增量修改，**保留全部既有逻辑**（selected/onNodesChange/onConnect/onCanvasDrop/triggerCfg/varGroups/Webhook 会话/审批通讯录等）。

- [ ] **Step 1: newPipeline 默认名称 + 默认触发节点**

`const newPipeline = () => ({...})`（第 39-43 行）替换为：

```js
const triggerNodeId = "t1";
const newPipeline = () => ({
  id: null, name: "未命名流水线", description: "",
  // 统一触发参数：manual 与 webhook 共用一份 params（webhook 用每项的 jsonPath 从请求体取值）
  // 触发源 = 画布 trigger 节点（type:"trigger"，锁定不可删）；参数 schema 仍存顶层 spec.trigger.params（后端读取点）
  spec_json: {
    nodes: [{ id: triggerNodeId, type: "trigger", kind: "manual", params: {}, name: "触发源", position: { x: 60, y: 60 } }],
    edges: [],
    trigger: { params: [] },
  },
});
```

- [ ] **Step 2: NODE_KINDS 补 trigger + 节点库分组常量**

现有 `const NODE_KINDS = {...}`（第 322-326 行）前插入一行 trigger 定义：

```js
const NODE_KINDS = {
  trigger:  { label: "触发源",   accent: "var(--warn)", icon: "M5 3h14v18l-7-4-7 4z" },
  shell:    { label: "Shell 执行",   accent: "var(--accent)",  icon: "M4 5l6 7-6 7m8 0h8" },
  approval: { label: "人工审批",     accent: "var(--ember)",   icon: "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6zm-3.5 6.5L11 12l4-4.5" },
  sql:      { label: "SQL 执行",     accent: "var(--accent)",  icon: "M4 5h16M7 3l2 2-2 2M12 3l2 2-2 2M7 12H4v3h3zM4 21h7M6 15v6M15 8l5 5M15 13h2a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2h-2" },
};
```

NODE_KINDS 定义后追加节点库分组（trigger 不进节点库，系统默认放置）：

```js
const LIB_TYPES = ["shell", "approval", "sql"];
const isTrigger = (n) => n?.type === "trigger";
```

- [ ] **Step 3: 触发节点锁定守卫（删除/连入禁止）**

`removeNodeById`（第 124-133 行）开头加守卫：

```js
function removeNodeById(id) {
  if (id === triggerNodeId || isTrigger(nodes.value.find((x) => x.id === id))) return; // 触发节点锁定不可删
  const i = nodes.value.findIndex((x) => x.id === id);
  ...
}
```

`onConnect`（第 106-122 行）`source === target` 判重前加一条：

```js
  if (target === triggerNodeId) {
    notify({ type: "error", message: "触发源是起点，只能作为出边，不能连入" });
    return;
  }
```

`onNodesChange` 的 remove 分支已走 `removeNodeById`（守卫自动生效）。

- [ ] **Step 4: hydrate 为旧数据注入触发节点**

`hydrate()`（第 205-225 行）中 `ensurePositions();` 之前插入：

```js
    // 触发源画布化：旧数据 nodes 无 trigger 节点时注入一个（kind 取顶层 trigger.kind，缺省 manual）
    if (!current.value.spec_json.nodes.some((n) => isTrigger(n))) {
      current.value.spec_json.nodes.unshift({
        id: triggerNodeId, type: "trigger",
        kind: current.value.spec_json.trigger?.kind ?? "manual",
        params: {}, name: "触发源", position: defaultNodePosition(),
      });
    }
```

（`newPipeline()` 分支不用注入——已有默认触发节点。注意 `hydrate` 里 `isNew` 分支直接 `newPipeline()` 并 return。）

- [ ] **Step 5: kind ↔ 浮窗 tab 双向同步**

`triggerCfg` computed（第 677-683 行）之后追加 watch：

```js
// 触发节点 kind 与浮窗 tab 双向同步；镜像写顶层 spec.trigger.kind（后端不读，仅语义化）
watch(triggerTab, (v) => {
  const t = nodes.value.find((n) => isTrigger(n));
  if (t) { t.kind = v; current.value.spec_json.trigger.kind = v; }
});
```

- [ ] **Step 6: 名称内联编辑状态**

script 区（`pageTitle` computed 附近）追加：

```js
const nameEditing = ref(false);
const nameDraft = ref("");
const nameInputEl = "pipeline-name-input";
function startNameEdit() {
  nameDraft.value = current.value.name;
  nameEditing.value = true;
  nextTick(() => { document.getElementById(nameInputEl)?.focus(); document.getElementById(nameInputEl)?.select(); });
}
function commitName() {
  if (!nameEditing.value) return;
  const v = String(nameDraft.value ?? "").trim();
  if (!v) { notify({ type: "error", message: "流水线名称不能为空" }); nameDraft.value = current.value.name; nameEditing.value = false; return; }
  current.value.name = v;
  nameEditing.value = false;
}
function cancelName() { nameEditing.value = false; }
```

`pageTitle` computed（第 203 行）删除或保留均可（模板不再引用则删除，避免 dead code——**删除**）。

- [ ] **Step 7: 浮窗拖动状态 + fitAll**

script 区（NODE_KINDS 之后）追加：

```js
const floatPos = ref({ right: "24px", top: "80px" });
let floatDrag = null;
function startFloatDrag(e) {
  floatDrag = { dx: e.clientX, dy: e.clientY, right: floatPos.value.right, top: floatPos.value.top };
  window.addEventListener("mousemove", onFloatDrag);
  window.addEventListener("mouseup", stopFloatDrag);
}
function onFloatDrag(e) {
  if (!floatDrag) return;
  const right = Math.max(8, parseFloat(floatDrag.right) + (floatDrag.dx - e.clientX));
  const top = Math.max(8, parseFloat(floatDrag.top) + (e.clientY - floatDrag.dy));
  floatPos.value = { right: right + "px", top: top + "px" };
}
function stopFloatDrag() {
  floatDrag = null;
  window.removeEventListener("mousemove", onFloatDrag);
  window.removeEventListener("mouseup", stopFloatDrag);
}
onBeforeUnmount(() => stopFloatDrag());
const fitAll = () => { nextTick(() => { fitView({ padding: 0.2, duration: 250 }).catch(() => {}); }); };
```

- [ ] **Step 8: 画布空态改判（仅无业务节点时显示）**

现模板第 1112 行 `v-if="!current.spec_json.nodes.length"` 改为 `v-if="!current.spec_json.nodes.some((n) => !isTrigger(n))"`（在 T4 模板步骤中一并处理）。

- [ ] **Step 9: 构建验证**

Run: `cd frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: 构建通过（此时模板仍引用 pageTitle 会编译失败——**T3 与 T4 必须一起提交**，中间态不单独构建/提交）。

---

## Task 4: PipelineEdit 模板重排（topbar + 左节点库 + 画布撑满 + 悬浮浮窗）

**Files:**
- Modify: `frontend/src/pages/PipelineEdit.vue`

原则：**移动而非重写**。现有 1490 行内的表单/插槽代码原位搬移，只改容器结构。以「包一层 + 剪切替换」方式操作，避免整体重敲。

- [ ] **Step 1: 页面根容器改为全高纵向**

模板根 `<div class="page">`（第 912 行）改为：

```html
  <div class="editor-page">
```

- [ ] **Step 2: 顶部工具栏（替换现 header + name-bar + toolbox 整体）**

将现有 `<header class="page-head">...</header>`（913-934）、`<section class="name-bar">...</section>`（937-947）、`<section class="toolbox">...</section>`（950-970）**整体替换**为：

```html
    <!-- 顶部工具栏 -->
    <header class="topbar">
      <button class="btn btn-ghost" @click="back">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        返回列表
      </button>

      <div class="tb-name-wrap">
        <template v-if="nameEditing">
          <input :id="nameInputEl" class="tb-name-input display" v-model="nameDraft"
            @keydown.enter="commitName" @keydown.esc="cancelName" @blur="commitName" />
        </template>
        <template v-else>
          <h1 class="tb-name display" :title="current.id ? '名称是 Webhook 触发地址的一部分，改名并保存后需重新复制触发地址' : ''">{{ current.name || "未命名流水线" }}</h1>
          <button type="button" class="btn btn-sm btn-ghost tb-name-edit" title="重命名流水线" @click="startNameEdit">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
          </button>
        </template>
      </div>

      <span class="toolbox-spacer"></span>

      <button class="btn btn-ghost" title="按依赖关系重新排布所有节点" @click="autoLayout">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9a2 2 0 1 0 0-.01M12 9a2 2 0 1 0 0-.01M20 9a2 2 0 1 0 0-.01M4 15a2 2 0 1 0 0-.01M12 15a2 2 0 1 0 0-.01M20 15a2 2 0 1 0 0-.01M4 21a2 2 0 1 0 0-.01M12 21a2 2 0 1 0 0-.01M20 21a2 2 0 1 0 0-.01"/></svg>
        自动布局
      </button>
      <button class="btn btn-ghost" title="恢复到适合视角" @click="fitAll">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
        回到原位
      </button>
      <button class="btn" @click="run" :disabled="!current.id" title="配置触发参数并运行">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        运行
      </button>
      <button class="btn btn-accent" @click="save({ stay: true })" :disabled="saving">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8"/></svg>
        {{ saving ? "保存中…" : "保存" }}
      </button>
    </header>
```

- [ ] **Step 3: 编辑体三栏容器 + 左侧节点库**

在 `</header>` 之后、触发源 config 区（现 `<section class="trigger-card">`，973 行）**之前**插入编辑体容器，并把触发源 config 区整块**移入**其中：

将现 `<section class="trigger-card card rise" ...>...</section>`（973-1061）整体替换为编者体三栏 + 触发源卡片改为**悬浮浮窗的外部模板片段载体**（本步先搭骨架，浮窗内容在 Step 5 迁入）。**实际操作**：把 trigger-card 整块**剪切到浮窗模板**（见 Step 5），此处不留触发源卡片。本步在此处插入：

```html
    <!-- 编辑体：左节点库 + 画布 + 悬浮浮窗 -->
    <div class="editor-body">
      <!-- 左栏：节点库（点击添加 / 拖入画布） -->
      <aside class="node-lib">
        <div class="lib-head">
          <span class="mono-tag">节点库</span>
        </div>
        <button v-for="k in LIB_TYPES" :key="k" class="btn node-add lib-item" :class="k"
          draggable="true" :title="`${NODE_KINDS[k].label}：点击添加，或拖到画布上指定位置`"
          @dragstart="onLibDragStart($event, k)" @click="addNode(k)">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="NODE_KINDS[k].icon" /></svg>
          {{ NODE_KINDS[k].label }}
        </button>
        <p class="toolbox-hint muted">点击添加，或拖入画布指定位置</p>
      </aside>

      <!-- 中区：画布（撑满） -->
      <main class="canvas-zone" @dragover.prevent="onCanvasDragOver" @drop.prevent="onCanvasDrop">
        <div class="canvas-grd"></div>
        <VueFlow ...>（原 VueFlow 整块，见 Step 4）</VueFlow>
        <div v-if="!current.spec_json.nodes.some((n) => !isTrigger(n))" class="empty">
          ...（原空态文案，改为「从左侧节点库点击添加，或拖入画布指定位置…」）
        </div>
      </main>
    </div>
```

- [ ] **Step 4: 画布 VueFlow 与节点/边插槽原样保留**

现 `<div class="canvas card" @dragover...>...</div>`（1065-1119）区域：删除外层 `.canvas card` 容器，其内部 `<div class="canvas-grd"></div>`、`<VueFlow>...</VueFlow>`（1068-1110）与空态（1112-1118，条件改 Step：`!current.spec_json.nodes.some((n) => !isTrigger(n))`）**整体移入** Step 3 的 `.canvas-zone` 内。插槽 `#node-dag-node`（1081-1096）与 `#edge-default`（1098-1109）原样不动；其中 `cn-del` 按钮加条件隐藏：

```html
              <button v-if="!isTrigger(data.n)" class="cn-del nodrag" title="删除节点" @mousedown.stop.prevent @click.stop="removeNodeById(data.n.id)">
```

并给画布节点加触发节点样式标记：`<div class="canvas-node" :data-type="data.n.type" :class="{ 'is-trigger': isTrigger(data.n) }">`。

- [ ] **Step 5: 悬浮浮窗（原右侧配置面板 + 触发源配置迁入）**

删除原右侧 `<div class="config card" :class="{ on: !!selected }">...</div>`（1122-1427）整体；在 `.editor-body` 容器内（`</main>` 之后）追加：

```html
      <!-- 悬浮参数浮窗：仅选中节点时显示，可拖动/关闭 -->
      <Transition name="float">
        <div v-if="selected" class="param-float" :style="floatPos" @mousedown.stop>
          <div class="float-head" @mousedown="startFloatDrag">
            <span class="cfg-kind" :style="{ backgroundColor: NODE_KINDS[selected.type].accent }">{{ NODE_KINDS[selected.type].label }}</span>
            <template v-if="!isTrigger(selected)">
              <input class="cfg-name-input" v-model="selected.name" :placeholder="NODE_KINDS[selected.type].label" title="节点名称（执行详情页展示用）" />
            </template>
            <span class="cfg-id mono">{{ drainId(selected.id) }}</span>
            <span class="toolbox-spacer"></span>
            <button type="button" class="btn btn-sm btn-ghost" title="收起" @click="selectedId = ''">×</button>
          </div>

          <div class="float-body">
            <!-- 触发源配置：原 trigger-card 模板整体迁入（seg tabs + 参数表 + 调试接收；变量/逻辑全保留） -->
            <template v-if="isTrigger(selected)">
              <div class="trig-head">
                <span class="mono-tag">触发源</span>
                <div class="seg-tabs">
                  <button type="button" class="seg-tab" :class="{ active: triggerTab === 'manual' }" @click="triggerTab = 'manual'">手动触发</button>
                  <button type="button" class="seg-tab" :class="{ active: triggerTab === 'webhook' }" @click="triggerTab = 'webhook'">Webhook 触发</button>
                </div>
              </div>
              <template v-if="triggerTab === 'manual'">
                <p class="field-hint trig-desc">运行弹窗将按此 schema 渲染表单；填写的值作为执行期变量注入，可用 <code class="mono ph-code">${key}</code> 引用。</p>
                <TriggerParamsEditor :params="triggerParams" />
              </template>
              <template v-else>
                <!-- 原 trigger-card 的 webhook 分支（地址/复制/获取/重置 + 调试接收 + Webhook 参数表 jsonPath + 限制说明）整体迁入，逻辑引用不变 -->
              </template>
            </template>

            <!-- 原右侧配置面板表单整体迁入（shell / sql / approval 原样；\`<div class="node-body" v-for="n in [selected]">\` → 去掉外层 node-body 容器直接放表单） -->
          </div>
        </div>
      </Transition>
```

> **迁入细则**：
> - 「触发源 webhook 分支」：把现 trigger-card 内 `v-else` 模板（989-1060，含 `.field` Webhook 地址、`.probe-panel` 调试接收、`.wh-limits`）原样搬到上面 `<template v-else>` 内。
> - 右侧面板表单：现 `.cfg-body .node-body`（1131-1421）按 `selected.type` 的 `v-else-if` 链整体搬入 `.float-body`（去掉 `v-for="n in [selected]"` 包装，变量 `n` 引用就地替换为 `selected`，或保留 `const n = selected` 的 `v-for` 单元素技巧以零改动迁移——**推荐保留 `v-for="n in [selected]"` 以最小改动**）。
> - `.cfg-head` → `.float-head`（模板已给）；原「收起」按钮保留。
> - Webhook 地址占位、`copyHook/loadHook/armReset/startProbe` 等全部是 script 引用，无需改脚本。

- [ ] **Step 6: 样式：全高布局 + 节点库 + 浮窗 + 过渡**

`.page` 等旧样式替换/追加（scoped 样式区）：删除 `.page`、`.page-head`、`.name-bar`、`.toolbox` 相关（或原地改为新类），追加：

```css
.editor-page { height: 100%; display: flex; flex-direction: column; gap: 12px; min-height: 0; width: 100%; }
.topbar {
  flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; border-bottom: 1px solid var(--line);
}
.tb-name-wrap { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tb-name { margin: 0; font-size: 17px; font-weight: 700; letter-spacing: .01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb-name-input {
  font-family: var(--font-display); font-size: 17px; font-weight: 700;
  width: 320px; padding: 3px 8px; background: var(--bg-1);
  border: 1px solid var(--accent); border-radius: 8px; color: var(--text-1);
}
.tb-name-edit { flex: 0 0 auto; }

.editor-body { flex: 1 1 auto; min-height: 0; display: flex; gap: 12px; position: relative; }

.node-lib {
  flex: 0 0 208px; display: flex; flex-direction: column; gap: 8px;
  padding: 14px 12px; background: linear-gradient(180deg, var(--bg-2), var(--bg-1));
  border: 1px solid var(--line); border-radius: var(--radius); position: relative; overflow-y: auto;
}
.lib-item { justify-content: flex-start; gap: 9px; }
.lib-item.shell { color: var(--accent); background: var(--accent-soft); border-color: transparent; }
.lib-item.shell:hover { background: rgba(84,208,198,.2); }
.lib-item.approval { color: var(--ember); background: var(--warn-soft); border-color: transparent; }
.lib-item.approval:hover { background: rgba(255,192,77,.22); }
.lib-item.sql { color: var(--accent); background: var(--accent-soft); border-color: transparent; }
.lib-item.sql:hover { background: rgba(84,208,198,.2); }

.canvas-zone { flex: 1 1 auto; min-width: 0; position: relative; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-0); }
.canvas-grd { position: absolute; inset: 0; pointer-events: none; opacity: .7;
  background-image: linear-gradient(rgba(122,160,240,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(122,160,240,0.05) 1px, transparent 1px);
  background-size: 26px 26px; }
.cflow { position: absolute; inset: 0; }

/* 悬浮浮窗 */
.param-float {
  position: fixed; width: 420px; max-width: calc(100vw - 40px); max-height: calc(100vh - 120px);
  display: flex; flex-direction: column; z-index: 50;
  background: linear-gradient(180deg, var(--bg-2), var(--bg-1));
  border: 1px solid var(--line-strong); border-radius: 14px; box-shadow: 0 18px 48px rgba(0,0,0,.5);
  overflow: hidden;
}
.float-head { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; padding: 10px 12px; border-bottom: 1px solid var(--line); cursor: grab; }
.float-head:active { cursor: grabbing; }
.float-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 14px; }
.float-enter-active, .float-leave-active { transition: opacity .16s var(--ease), transform .16s var(--ease); }
.float-enter-from, .float-leave-to { opacity: 0; transform: translateY(-6px); }
.canvas-node.is-trigger { border-left-color: var(--warn); }
```

> 现有 `.config`/`.cfg-*` 样式若与浮窗类冲突，直接改名替换；`.node-body`（面板表单容器）保留用于浮窗内滚动（`.float-body` 已代为滚动容器，`node-body` 可保留且改 `padding:0`）。

- [ ] **Step 7: 构建 + 手测清单**

Run: `cd frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: 构建通过。按规格 §10 手测清单逐项执行（8 条）。

- [ ] **Step 8: 提交**

```bash
cd /workspace
git add frontend/src/pages/PipelineEdit.vue
git -c user.name="spencerswagger" -c user.email="devcloud@fcy.zj.cn" commit -m "feat(frontend): 编辑页重排为全画布（topbar 名称内联编辑 + 左节点库 + 画布撑满 + 悬浮参数浮窗 + 触发源画布化）"
```

---

## Self-Review

**1. 规格覆盖核对：**
- §3 页面骨架/需求4（画布撑满）→ T4 Step 1-4、6。✓
- §4 名称编辑/需求2 → T3 Step 6 + T4 Step 2。✓
- §5 触发节点/需求3 → T1（后端 step）+ T3 Step 1-5 + T4 Step 4。✓
- §6 悬浮浮窗/需求5 → T3 Step 7 + T4 Step 5。✓
- §7 左侧节点库/需求6 → T3 Step 2（LIB_TYPES）+ T4 Step 3。✓
- §8 后端改动 → T1。✓
- §9 兼容（旧数据注入触发节点）→ T3 Step 4。✓
- §10 测试 → T1 Step 4-5、T2 Step 3、T4 Step 7。✓
- 规格里需求 1（隐藏侧栏）→ T2。✓

**2. 占位符扫描：** 无 TBD/TODO；T4 Step 5 中 `n` 引用采用「保留 `v-for="n in [selected]"`」消除「替换为 selected」的两义写法。✓

**3. 类型/命名一致性：**
- `triggerNodeId` T3 Step 1 定义，Step 3/4 引用一致。✓
- `isTrigger` T3 Step 2 定义，Step 3 与 T4 Step 4/5 模板引用一致。✓
- `startNameEdit/commitName/cancelName/nameDraft/nameEditing/nameInputEl` T3 Step 6 定义，T4 Step 2 模板一致；`nameInputEl` 直接插入 `:id`。✓
- `floatPos/startFloatDrag/onFloatDrag/stopFloatDrag` T3 Step 7 与 T4 模板一致；`fitAll` T4 Step 2 引用。✓
- `LIB_TYPES` T3 Step 2 定义，T4 Step 3 `v-for` 引用。✓
- Save 按钮 `save({ stay: true })` 与规格 §2「保存停留本页」一致。✓
- trigger node `kind` 字段：T3 Step 1 初始 manual、Step 4 旧数据取顶层、Step 5 watch 同步。✓

**4. 已知注意点（已内联）：**
- T3 Step 9 注明 T3 与 T4 必须一起提交（中间态删了 pageTitle 会编译失败）。
- T4 以「移动而非重写」为原则，避免 1490 行文件全量重敲导致回归。
- STEP_TYPES 防漂移检查要求 steps 同步装配（T1 Step 3 已双改）。