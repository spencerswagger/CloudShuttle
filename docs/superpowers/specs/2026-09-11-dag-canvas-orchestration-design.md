# DAG 画布编排与真并行执行 设计文档

**日期:** 2026-09-11
**特性分支:** `feat/dag-canvas-orchestration`

## 背景与目标

当前流水线编辑在 `PipelineEdit.vue` 中用**纵向数组列表**顺序排列节点，连线关系隐式（上一个 → 下一个）；后端引擎虽已是 DAG 规格（`spec.nodes + spec.edges`）且能沿 edges 按就绪度推进，但对同一轮就绪的多个无依赖节点是**顺序 await 串行执行**，无法并行。

**目标：**
1. 前端编辑页改为 **DAG 自由画布** 编辑（拖拽节点、就近吸附建边、一键自动布局、右侧配置面板）。
2. **真并发执行**：同一轮就绪的多个无依赖节点（含多个 shell/ECI 容器）同时派发执行。
3. 执行详情页改为**画布视图**，并行节点同时高亮展示进度。

## 现状盘点（已核实）

- **后端引擎**：`backend/engine/dag.js`（`buildGraph`/`nextReady`/`ancestors`）、`backend/engine/state.js`（`createAdvancer.advanceOnce`）、`backend/engine/orchestrator.js`（`run`/`markDone`/`onEciDone`/`onEciFail`/`onApproval`）。
- **串行瓶颈**：`state.js::advanceOnce` 对 `ready` 节点用 `for...of + await stepRun(...)` 逐个串行；shell/ECI 节点用 `break` 一次推进只派发一个等待节点。
- **写安全**：`writeNodeRecord` 按 `(exec_id, node_id)` UPSERT（`ON CONFLICT`），不同节点行互不冲突，并发写库安全；`snapshotStore` 写 redis，`done` 集合与 `waiting` 需在并发下更新。
- **spec 数据模型**：`{ nodes: [], edges: [], trigger: { params: [] } }`。
- **前端**：`PipelineEdit.vue`（1592 行节点编排，含 `nodes` computed、变量面板 `varGroups` 沿 edges 取上游输出、节点参数表单、`addNode`）、`ExecutionDetail.vue`（列表）。

## 架构决策

| 决策项 | 结论 | 理由 |
|---|---|---|
| 画布形态 | 自由画布（方案 B） | 任意拓扑可表达，用户选定 |
| 连线方式 | 就近拖拽吸附建边 | 轻量、不易画错 |
| 并行程度 | 真并发执行 | 用户明确要求 |
| 画布技术栈 | 引入现成 DAG 画布库（Vue Flow） | 省去拖拽/连线/缩放/自动布局自研，契合 Vue3 |
| 执行详情 | 画布视图 | 直观呈现并行进度 |
| 并发覆盖 | 全部节点类型（含多 ECI 同时跑） | 用户明确要求 |
| 排版 | 自由拖拽 + 一键自动整理 | 灵活与可读兼顾 |

### 前端画布库选型：Vue Flow

- 采用 `@vue-flow/core`（Vue3 官方推荐画布库，树摇友好、纯 Vue3）。
- **依赖打包约束**：Vue Flow 源码随 `npm run build` 打包进 dist，通过本地 node_modules 引入，**不引外部 CDN**，符合 AGENTS.md「前端所有依赖（含字体）都要打包，避免外部在线资源」。
- 自动布局借 daisy 或手写分层布局算法（按 edges 计算层级、同层横排、落位后写入 node.position）。

## 组件与数据流

### 前端：PipelineEdit.vue（编辑画布）

```
PipelineEdit.vue
 ├─ 可滚动/缩放画布（VueFlow: 节点 = 节点卡，边 = spec.edges）
 │    ├─ 从侧边「节点类型库」拖入画布 → 新增节点（addNode）
 │    ├─ 就近拖拽吸附 → 选中上游节点拖到目标节点下方 → 生成 edge（from→to）
 │    ├─ 拖动节点 → 更新 node.position（持久化）
 │    ├─ 点节点 → 右侧配置面板（复用现有节点参数表单）
 │    └─ 边 hover 可删除；拖出环 → 高亮警告并阻止
 ├─ 顶部工具条：一键自动布局、缩略图/缩放、保存
 └─ 右侧配置面板：节点类型/参数/变量插入（复用 varGroups）
```

**spec 映射：**
- 节点 → `spec.nodes[]`（含 `id/type/step/params/name`，新增 `position:{x,y}`）
- 边 → `spec.edges[]`（`{from,to}`）
- 后端对 `position` 字段需**容忍并保留**（spec 存储/回显不透弃）。

### 前端：ExecutionDetail.vue（执行画布）

- 同用 VueFlow，节点按依赖静态布局；
- 每个节点从 execution_node 记录读取状态（pending/running/done/failed），并行中节点同时高亮；
- 点节点显示该节点 output/logs 详情（沿用现有面板）。

### 后端：engine/state.js（真并发）

把 `advanceOnce` 对就绪节点的**串行 for...await** 改为**并发派发**：

1. `Promise.allSettled` 并发执行同轮所有就绪节点（对 `kind:'done'` 就地记录，对 `kind:'dispatch'/'wait'` 登记等待回调）。
2. `done` 集合更新改为**串行化**（用 `mutex`，与 ECI 回调续跑共用同一把锁，防并发写快照竞态）。
3. 多 ECI 同时派发：每个 dispatch 节点带独立回调 token，`onEciDone` 用同一个 mutex 串行化「markDone + 续跑」，避免多个回调同时续跑造成重复推进。
4. 变量副作用：并发节点的 output 都写入共享 environment，语义为「就绪时快照的环境 + 各自输出」，后继节点取到自己前驱的完整输出。

**关键改动点：**
- `advanceOnce`：`for...of await` → `Promise.allSettled(ready.map(...))`。
- shell/ECI 派发：去掉「一次推进只派发一个」的 `break` 限制，支持一轮派发多个 ECI。
- 引入 `mutex`（现有 `engine/mutex.js`）包裹 `done`/`waiting`/snapshot 更新。

### 后端：spec 校验（新增）

- 保存/运行前校验 DAG 合法性：无环、无重复节点 id、边两端节点存在；环则报错并画布标红。

## 错误处理

- 画布创建环 → 前端即时阻止 + 后端校验层兜底报错。
- 并发执行中单节点失败 → 该节点标记 failed，执行终态 failed（沿用现有 `failExecution`）；同轮其他节点已派发的不主动终止。
- 并发写快照 → mutex 串行化，杜绝竞态。

## 测试策略

- **后端**：`state.js` 新增并发用例——两个无依赖就绪节点同一轮均被执行（断言并发调用进 stepRun 次数为 2，且有重叠执行窗口）；多 ECI 派发多 token；环校验；并发回调续跑互斥。
- **前端**：构建通过；画布新增/建边/自动布局交互用浏览器验证。
- **回归**：现有串行场景（单一链路）仍全部通过（t9）。

## 范围（YAGNI 裁剪）

- 本阶段不做：画布撤销/重做、节点复制粘贴、多选/框选、历史版本对比、DAG 节点告警/事件（富 UI）。仅保留完成目标的最小交互集。
- 不做后端并发度限制配置（先按「同轮全部就绪并发」的简单语义）。
- `position` 仅作编辑记忆，不做拖拽碰撞/磁性对齐网格。

## 数据模型变更

- `spec.nodes[]` 允许新增可选 `position:{x,y}`（后端存储/回显原样保留）。
- `spec.edges[]` 已是现状，无结构变更。