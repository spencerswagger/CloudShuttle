# 流水线编辑页全画布重构（隐藏侧栏 / 触发节点 / 悬浮参数 / 左侧节点库）设计规格

日期：2026-09-14

## 1. 背景与目标

当前 `/pipelines/new` 与 `/pipelines/:id` 共用一个 `PipelineEdit.vue` 单页：命名栏、触发源配置、节点库、画布全部堆叠纵向排列，画布只占约四分之一空间，全局左侧边栏常驻。用户提出的 6 项优化：

1. 新增/编辑页隐藏全局左侧边栏。
2. 弱化流水线名称编辑：放标题上、有默认名称、点编辑按钮变为可编辑。
3. 触发源改为画布节点，新建时默认就有一个。
4. 画布撑满界面。
5. 节点参数编辑框改为悬浮浮窗，仅选中节点时显示。
6. 节点库改为左侧边栏展示，点击或拖入画布。

上一版计划（2026-09-11-dag-edit-rework）仅写档未实施，其中「新建两步流程（命名+触发源→保存跳转）」与本次需求 2/3 冲突，本规格取代之；控制节点类型（branch/join/loop/node）不在本期范围。

## 2. 设计决策（已与用户确认）

- **后端改动：最小支持**。新增 no-op 的 `trigger` step + `STEP_TYPES` 注册。触发参数 schema 仍存顶层 `spec.trigger.params`（后端 `triggerParamsOf` 读取点不变），触发节点仅存 `kind` 作为画布标记。旧流水线执行路径完全不变。
- **触发节点锁定不可删**：无删除按钮、画布 remove 事件忽略、`removeNodeById` 对该类型 return。
- **默认名称**：「未命名流水线」。
- **节点库仅现有三类**：Shell 执行 / 人工审批 / SQL 执行（trigger 不进节点库，系统默认放置）。
- **新建/编辑同构**：单一全画布编辑页，`/pipelines/new` 与 `/pipelines/:id` 同一布局与交互，仅保存（create/update）与回填（hydrate）不同。
- **保存停留本页**：编辑页 save 使用 stay 模式，避免保存即跳转丢画布位置。

## 3. 页面骨架（画布撑满）

```
.editor-page（100vh，flex column，min-height:0）
├── .topbar　← 返回列表 + 名称(默认只读/点铅笔可编辑) + 自动布局 + 回到原位(fitView) + 运行 + 保存
└── .editor-body（flex:1，min-height:0，display:flex）
    ├── .node-lib　（左侧节点库，≈208px 固定宽）
    └── .canvas-zone（flex:1，min-width:0，position:relative）
        ├── .canvas-grd（网格背景）
        └── VueFlow（absolute inset:0）
```

- 路由：`/pipelines/new` 与 `/pipelines/:id` 加 `meta: { noSidebar: true }`；App.vue `<aside v-if="!route.meta.noSidebar">`，`.main--bare`（`padding:0; overflow:hidden`）撑满。
- 挂载/回填后 `fitView({ padding:0.2 })`；沿用 `autoLayout()` 与新增 `fitAll()`（纯 fitView）。

## 4. 名称弱化编辑

- 新建默认 `name = "未命名流水线"`。
- Topbar 标题区：只读显示 `current.name` + 铅笔按钮；点击 → 内联 `<input>`（自动聚焦、全选），Enter/失焦提交、Esc 取消。无独立「命名栏」字段。
- 已保存流水线：`title` 提示「名称是 Webhook 触发地址的一部分，改名保存后需重新复制触发地址」。
- `pageTitle` computed 由「新建流水线/编辑流水线 · name」改为标题内联名（不再单独展示）。

## 5. 触发源 → 画布节点

- `newPipeline()` 默认：

```js
{
  id: null, name: "未命名流水线", description: "",
  spec_json: {
    nodes: [{ id: "t1", type: "trigger", kind: "manual", params: {}, position: { x: 60, y: 60 } }],
    edges: [],
    trigger: { params: [] },   // 参数 schema 仍存顶层（后端读取点不变）
  },
}
```

- 编辑态回填兜底：`hydrate()` 若 nodes 无 `type==="trigger"` 节点（历史数据），注入一个（`kind` 取 `spec.trigger.kind` 或默认 manual；位置取 `defaultNodePosition()`）。
- 锁定：`NODE_KINDS` 补 `trigger`（`触发源 · var(--warn)`）；画布节点删按钮对 trigger 隐藏；`onNodesChange` 的 remove 与 `removeNodeById` 对 trigger 忽略。
- 触发节点点击 → 浮窗打开触发源配置：seg tabs（手动/Webhook）+ `TriggerParamsEditor`（:params="triggerParams"）+ Webhook 地址区（复制/获取/重置密钥/调试接收探针，现有模板整体迁入）+ `ensureSaved` 先保存流程不变。
- kind 与浮窗 tab 双向同步（`node.params.kind ↔ triggerTab`），并镜像写 `spec.trigger.kind`（后端不读，仅语义化）。

## 6. 节点参数悬浮浮窗

- 替换现有右侧 400px `.config` 抽屉：`v-if="selected"` 才渲染（Transition 淡入），默认定位编辑区右上，头栏可拖动（mousedown + window mousemove/mouseup），× 关闭，点画布空白（`onPaneClick`）关闭。
- 浮窗内按 `selected.type` 渲染：trigger / shell / sql / approval 现有表单整体迁入（含变量插入 `varDrop`、`onFieldFocus`、`autofit`/`fitAll`）。
- `.org-mask`（通讯录选择器）与 `RunPipelineModal` 为整屏弹层，z-index 高于浮窗，不受影响。
- 浮窗 `position: fixed` 定位（top/right 偏移量响应式记录，拖动时更新），不随编辑区滚动脱离。

## 7. 左侧节点库

- `.node-lib`：标题「节点库」+ 三个按钮（图标+标签，配色沿用 NODE_KINDS）：Shell 执行 / 人工审批 / SQL 执行。
- 交互：点击追加（`addNode(type)`，新节点自动选中弹浮窗）；HTML5 拖入画布指定落点（复用 `onLibDragStart` / `onCanvasDragOver` / `onCanvasDrop`）。
- 底部 hint：点击添加或拖入画布指定位置；拖节点右侧手柄到目标左侧手柄建立依赖。
- 「自动布局」与「回到原位」移入 topbar；节点库不做折叠（YAGNI）。

## 8. 后端改动（最小支持）

| 文件 | 改动 |
|---|---|
| `backend/steps/trigger.js`（新） | `makeTriggerStep()` 返回 `{ kind:"done", output:{} }` |
| `backend/steps/trigger.test.js`（新） | 3 断言：done / output 空 / 与触发参数无关（环境注入由 hydrateForRun 完成） |
| `backend/index.js` | `STEP_TYPES` 加 `"trigger"`；`steps` 装配 `trigger: makeTriggerStep()`；静态 import |

- 不动：`variables.js triggerParamsOf`、`engine/trigger.js assembleTriggerEnv`、`engine/dag.js validateSpec`（无类型限制，trigger 节点直接通过）。
- 旧流水线（无 trigger 节点）执行路径不变：无 trigger step 被调用；顶层 `spec.trigger.params` 照常装配。
- 新流水线执行：trigger 节点是根（无前驱）首轮即 done，随后其下游正常推进；引擎 completion 判定 `done.size === nodes.size` 包含 trigger，行为无差异。

## 9. 数据模型与兼容

| 场景 | 行为 |
|---|---|
| 新建保存 | `nodes` 含 trigger 节点（validateSpec 无类型限制通过）；`trigger.params` 顶层保存 |
| 旧流水线编辑保存 | hydrate 注入 trigger 节点 → 保存持久化；执行时 trigger 首轮 done |
| 旧流水线直接执行（未编辑） | 无 trigger 节点、顶层参数照常装配 —— 完全不变 |
| 执行详情页 | `execution_node` 会出现 trigger 行（status done, output {}）；ExecutionDetail 按 type 通用渲染不崩溃 |

## 10. 测试策略

- 后端：`steps/trigger.test.js` 新增 3 断言；`cd backend && PATH="/usr/local/bin:$PATH" node --test` 全量回归。
- 前端：`cd frontend && PATH="/usr/local/bin:$PATH" npm run build` 构建回归。

### 手测清单

1. `/pipelines/new`：无全局侧栏；标题默认「未命名流水线」；画布默认有 1 个触发节点（不可删）。
2. 铅笔编辑名称：Enter 提交 / Esc 取消；保存后标题更新。
3. 左侧节点库点击/拖入添加 shell/approval/sql；新节点自动弹浮窗。
4. 浮窗：拖动、关闭、点画布空白关闭；shell 变量插入、approval 通讯录、sql 语句编辑可用。
5. 触发节点浮窗：手动/Webhook 切换、触发参数编辑、Webhook 地址获取（未保存先自动保存）、调试接收轮询正常。
6. 画布撑满整个可视区（无页面滚动）；自动布局 / 回到原位可用。
7. 编辑旧流水线：自动补触发节点；保存刷新不丢。
8. 运行：触发一条含 trigger 节点的新流水线，执行详情页正常完成，trigger 节点显示 done。