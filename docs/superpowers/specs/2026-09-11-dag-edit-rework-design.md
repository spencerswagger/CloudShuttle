# 新建流程拆分 + 全画布编辑页重构 + 控制节点类型 设计规格

日期：2026-09-11
分支：feat/dag-canvas-orchestration（在 v0.2.0-rc2 基础上继续）

## 1. 背景与目标

当前 `/pipelines/new` 与 `/pipelines/:id` 共用一个 `PipelineEdit.vue` 单页，命名栏、触发源配置、节点库、画布全部堆叠在一页里，画布只占约四分之一空间且需要滚动。用户希望：

1. **新建流程拆分**：创建流水线先填命名 + 触发源，确定即保存，然后跳转到编辑页。
2. **全画布编辑页**：编辑页不显示全局左侧边栏，大部分画面是画布；左侧为可拖入画布的节点类型库，中间为画布，节点参数以**悬浮浮层**覆盖在画布之上（不选中节点时右侧也是正常画布）。
3. **画布视角功能**：回到原位 / 调整到适合视角。
4. **更多节点类型**：并发已支持，补齐控制逻辑——条件分支、合并、循环（子流水线）、执行 Node 脚本。

## 2. 设计决策（已与用户确认）

- **布局方向 A**（可视化伴侣确认）：全画布三栏 + 悬浮参数。
- **触发源落法 A1**：起点节点写入 `spec.nodes`（`type:"trigger"`），画布数据与执行数据同源。
- **循环实现 B1**：Loop 节点 `params.loop.subSpec` 内嵌子流水线，递归调用现有 `advance/run` 执行，完全复用现有架构。
- **变量面板并入悬浮参数面板**（不常驻画布）。
- **循环内不允许回调节点**（用户确认限制）：子 spec 只允许 done 型节点（shell/sql/trigger/branch/join/node），审批/ECI 回调型节点在保存时校验拒绝。
- **脚本编辑器**：CodeMirror 6（本地打包，基础代码编辑器功能：高亮/行号/括号匹配/折叠/基础补全）。

## 3. 页面流程

| 阶段 | 路由 | 内容 | 全局侧边栏 |
|---|---|---|---|
| 新建 | `/pipelines/new` | 命名 + 触发源（手动/Webhook）→ 保存创建 | 保留 |
| 编辑 | `/pipelines/:id` | 全画布三栏编辑器 | **隐藏**（`meta.noSidebar`） |

- 新建页「保存并进入编辑」→ `POST /api/pipelines`（`spec_json.trigger.kind` + 起点 trigger 节点）→ 跳转 `/pipelines/:id`。
- 既有流水线（无 trigger 节点）打开编辑页时，由 `hydrate` 从 `spec_json.trigger` 派生起点节点（向后兼容）。

## 4. 编辑页布局（三栏 + 悬浮）

- 顶部工具栏：返回、流水线名、自动布局、回到原位（fitView）、保存。
- 左栏节点库（~220px，可折叠）：「起点」（手动触发/Webhook）「步骤」（Shell/SQL/审批/执行脚本）「控制」（条件分支/合并/循环），拖入或点击追加。
- 中区 VueFlow 画布占满；无限缩放/平移；`fitView` 按钮。
- 节点参数：点击节点 → 悬浮浮层（可拖动、可关闭）覆盖画布；不选中时无浮层、画布全宽。浮层内含：节点类型表单 + 可用变量面板（并入）。
- Loop 节点浮层内「编辑循环体」→ 打开嵌套子画布浮层（独立 VueFlow 实例编辑 `params.loop.subSpec`，复用节点库与 wouldCycle 判环）。

## 5. 数据结构（`spec_json` 扩展）

```js
{
  nodes: [
    { id, type:"trigger", kind:"manual"|"webhook", params:{}, position:{x,y} },
    { id, type:"branch",  params:{ expr:"${env}", cases:[{ value, edge }, { default:true, edge }] } },
    { id, type:"join",    params:{} },
    { id, type:"loop",    params:{ loop:{ items:"${arr}", subSpec:{ nodes, edges }, concurrency:1, maxIter?, itemVar:"item", indexVar:"index" } } },
    { id, type:"node",    params:{ script:"...", timeoutSec:120, maxMemoryMb:512 } },
    // 既有 shell/sql/approval 不变
  ],
  edges:[{from,to}],
  trigger:{ kind:"manual"|"webhook", params:{} }  // 顶层保留，兼容旧数据；起点节点从它派生
}
```

## 6. 后端引擎改造

### 6.1 buildGraph / validateSpec

- `validateSpec` 扩展：trigger 至多 1 个、kind 合法；branch 的 `cases[].edge` 必须对应一条出边；loop 的 `subSpec` 递归校验且**子 spec 内禁止 approval/eci 回调型节点**；node 脚本非空。
- `buildGraph`：trigger 视为初始就绪（无前驱），供 stepRun 识别。

### 6.2 stepRun 新增 step（backend/steps/）

- `trigger.js`：`{ kind:"done", output: 触发参数环境 }`，无副作用。
- `branch.js`：求值 expr → 匹配 case → `{ kind:"done", output:{}, branchChoice: edgeId }`；advance 按 branchChoice 过滤就绪集。
- `join.js`：`{ kind:"done", output:{ all:{ [nodeId]: output } } }`，无副作用。
- `node.js`：`child_process.fork` 跑脚本，`--max-old-space-size` 限制内存、超时 kill；stdout 忽略、stderr 截断入日志；返回 JSON 输出。
- loop 不在 steps 实现——引擎识别 `type:"loop"` 递归推进（6.3）。

### 6.3 Loop 递归执行（关键）

- `advanceOnce` 识别 `type:"loop"` → `runSubLoop`：
  - 派生 `subExecId = ${parentExecId}.it${i}`；
  - 每迭代：`advance({ spec: subSpec, snap: 空, execId: subExecId, environment: {...env, [itemVar]: item, [indexVar]: i} })`，复用现有 advanceOnce；
  - `concurrency` 控制并发迭代（默认 1 串行；>1 用 Promise.allSettled）；
  - 迭代结果按序收集 → Loop 输出 `{ results:[...] }`；
  - 子迭代失败 → `onError:"stop"|"continue"`（默认 stop）→ stop 时父 Loop 失败。
- **约束**：子 spec 仅 done 型节点 → 递归在单次 `advanceOnce` 调用栈内同步完成，不经回调续跑路径，无锁外路径、无死锁。
- 记录：子执行写记录 `execId = subExecId`，前端可按前缀归组（完整子迭代展示留后续）。

## 7. 前端改造

### 7.1 路由与 App.vue

- `router.js`：`/pipelines/new` 与 `/pipelines/:id` 均指向 PipelineEdit.vue；编辑路由带 `meta.noSidebar`。
- `App.vue`：`<aside class="sidebar">` 加 `v-if="!route.meta.noSidebar"`。

### 7.2 PipelineEdit.vue（新建形态 vs 编辑形态）

- 新建形态：命名 + 触发源卡片 → 保存并进入编辑。
- 编辑形态：三栏 + 悬浮浮层 + 子画布浮层；节点库按组；变量面板并入浮层。
- 触发源起点节点：新建决定 kind；编辑页可点击起点节点在浮层改触发参数。

### 7.3 CodeEditor.vue（新增组件）

- `@codemirror/view|state|lang-javascript|basic-setup`，Vue 3 封装；语法高亮/行号/括号匹配/折叠/基础补全；本地打包无外部资源。

### 7.4 ExecutionDetail.vue

- 画布支持新节点类型状态色（沿用 STATUS map）；loop 显示「迭代中 x/N」角标；子迭代记录按 execId 前缀归组（本期仅落库/提示，完整展开视图后续增强）。

## 8. 错误处理

- 一律人读、不透栈；`HttpError` 透出 message。
- Loop subSpec 非法（含回调节点、坏 subSpec）→ 保存/触发 400 BAD_DAG，中文 errors。
- node 脚本超时/内存超限 → 节点失败，用户侧「脚本超时/内存超限」人读信息，stderr 截断入日志。

## 9. 测试策略（TDD + 回归能抓旧实现）

- `dag.test.js`：validateSpec 递归校验 loop.subSpec、branch cases edge、trigger 唯一、子 spec 含回调节点被拒。
- `state.test.js`：branch 过滤就绪集、join 聚合 {all}、loop 串行/并发、loop 失败 stop/continue。
- `orchestrator.test.js`：loop 全 done 型递归推进收敛。
- `steps/node.test.js`：脚本输出 JSON、超时、内存限制、stderr 截断。
- handler 级：坏 loop.subSpec → 400 BAD_DAG。
- 前端：wouldCycle 回归、新建→编辑跳转、构建回归。

## 10. 交付范围

**包含**：新建流程拆分、无 sidebar 编辑页三栏、悬浮参数 + 变量面板并入、触发源起点节点、branch/join/loop/node 四类节点、Loop 子画布编辑、CodeMirror 脚本编辑器、执行详情画布状态适配、后端引擎扩展与全量测试。

**不包含（后续增强）**：执行详情子迭代完整展开视图、loop 并发调度器图形化配置（本期仅参数）、node 脚本 lint/补全增强。
