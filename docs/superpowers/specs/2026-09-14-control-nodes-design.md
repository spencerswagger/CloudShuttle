# 控制节点（branch / join / loop）设计规格

日期：2026-09-14

## 1. 背景与目标

现有节点类型为 `trigger / shell / approval / sql`。上一版设计（2026-09-14-pipeline-edit-canvas）明确将控制节点类型（branch/join/loop）划出范围、留待后续。本期补上：

- **branch**：边条件分支——每条出边带一个条件表达式，执行时逐边求值，未命中的边跳过
- **join**：汇聚点——分支场景等待所有已激活分支收敛；loop 场景作为循环出口
- **loop**：子图循环——loop→join 之间区域反复执行 N 次（固定次数或遍历数组），每轮注入迭代变量，输出累积为列表

明确不做（本期）：动作类节点（HTTP/延时/变量赋值/通知）、定时触发、循环体内嵌套控制节点、执行历史的分轮记录。

## 2. 总体方案（已与用户确认）

采用**推进式状态机扩展**（方案 A）：保持 FC「短请求、一次唤醒推进」架构与回调续跑机制不变，控制语义落在引擎推进层；branch/join/loop 的 step 均为 `{kind:"done", output:{}}` 纯标记（与 trigger 同一模式），逻辑由 `state.js` 承担。

关键前提改造：当前 `run()` 每次唤醒只推进一轮（state.js 单轮语义由测试锁定），纯同步链（sql1→sql2）推进一轮后没有第二次唤醒。控制节点（branch 剪枝后 join 才就绪、loop 多轮迭代）天然需要一次唤醒内连续推进多轮。故引入**推进层 drain 循环**（编排层新增，state.js 单轮语义与既有测试不动）。

## 3. 数据模型与画布

### 3.1 节点类型注册

| 文件 | 改动 |
|---|---|
| 后端 `index.js` | `STEP_TYPES` 加 `"branch" / "join" / "loop"`；steps 装配三个 `makeXxxStep()`，均返回 `{kind:"done", output:{}}` |
| 后端 `steps/branch.js`（新）、`steps/join.js`（新）、`steps/loop.js`（新） | 各带 3 条最小断言单测（done / output 空 / 与引擎控制逻辑无关） |
| 前端 `PipelineEdit.vue` | `NODE_KINDS` 补 branch（条件分支，琥珀）、join（汇聚，青色）、loop（循环，橙红）；`LIB_TYPES` 加入三类；trigger 仍锁定不可删 |

### 3.2 边条件结构（向后兼容扩展）

`spec.edges[]` 元素新增可选 `cond` 字段，旧边无 `cond` 即无条件边（恒激活，可作默认兜底分支）：

```js
{ from: "b1", to: "s2", cond: { path: "$.trigger.branch", op: "eq", val: "release" } }
```

- `path`：JSONPath 表达式，作用于「条件上下文」树（复用现有 `jsonpath-plus` 依赖）
- `op`：`eq / ne / gt / ge / lt / le / contains / starts_with / ends_with / exists / empty / regex`
- `val`：字面量（字符串/数字/布尔）

### 3.3 条件上下文树

branch 求值与 loop items 取数统一使用的 JSONPath 查询目标：

```js
{ trigger: <webhook 原始 body / manual 表单值>, outputs: { <nodeId>: <该节点结构化输出> }, env: <扁平环境> }
```

### 3.4 画布交互

- branch/join/loop 单进单出端口，与现有节点一致；branch 的多条条件边从同一出端口拉出
- **边条件编辑（新增交互）**：点选边 → 悬浮浮窗渲染边配置（`cond.path` JSONPath 输入 + `op` 下拉 + `val` 输入 + 删除边）；无条件边显示「默认」徽标，带条件边显示 `eq release` 徽标（VueFlow edge label）
- 浮窗表单：branch/join 无字段，仅说明文字；loop 节点表单含 `items` 配置（count 固定次数 / path JSONPath 取数组，radio 切换）与 `accumulate` 列表（key / from 下拉选 body 节点 / field 输出键，可增删）
- 执行详情页：`skipped` 状态灰显 + 「已跳过」标签

### 3.5 校验（validateSpec 扩展）

- 边条件格式：`path` 非空、`op` 在白名单
- loop 区域约束：
  - loop 出边全部指向 body 节点；join 入边全部来自 body 节点
  - body 内只允许普通节点（shell/sql/approval），不可嵌套 branch/join/loop/trigger
  - loop 出边不允许直连 join（循环体至少 1 个节点）
- 环检测等既有校验不变

## 4. 快照扩展（Redis，无 PG schema 改动）

| 字段 | 说明 |
|---|---|
| `snap.trigger_raw` | exec 创建时保存原始触发载荷（webhook body / manual formValue），由 `hydrateForRun → run(spec, environment, { triggerRaw })` 写入 |
| `snap.node_outputs` | `{ nodeId: <该节点结构化输出> }`，每轮结束刷新；ECI/审批回调（markDone）一并写入 |
| `snap.loops` | `{ [loopId]: { items: [], idx: 0, bodyIds: [], acc: {} } }`，见第 6 段 |

## 5. branch / join 引擎语义

### 5.1 推进流程（advanceOnce 内，处理完本轮结果后、落快照前）

```
每轮幂等重算（branch 可能在前几轮完成）：对每个已完成的 branch 节点，对其每条出边求值 cond（对条件上下文树做 JSONPath）
→ 未命中边进入 inactive 集
→ 不动点传播 dead 集：
    节点所有入边都是 inactive（或来自 dead 节点）→ 该节点 dead
    dead 节点记 done（status "skipped"，写入 execution_node，不注入 env），其出边也变 inactive
```

- 嵌套 branch 天然支持：不动点会穿过被跳过的 branch 继续传播
- **无匹配语义**：branch 全部出边未命中 → 下游全部 skipped，执行仍以 completed 正常结束（与 GitLab CI「job 跳过」一致）；不强制默认边，无 `cond` 的边恒激活可作默认兜底

### 5.2 join 节点

`{kind:"done", output:{}}` 纯标记，引擎零特殊逻辑——被跳过的节点已记 done，`nextReady` 要求全部前驱 done，join 自然收敛（所有已激活分支 + 已跳过分支都算完成）。

## 6. loop 引擎语义

### 6.1 结构

`loop 节点 → body（普通节点）→ join 节点`。校验保证 body 内无控制节点、join 入边全来自 body。

### 6.2 迭代来源

`node.params.items = { count: 5 }`（固定次数，内部展开为 `[1..N]`）或 `{ path: "$.trigger.refs" }`（JSONPath 从条件上下文树取数组）。

### 6.3 推进流程

1. **初始化**：loop 节点就绪（前驱全 done、`loops` 无此项）→ 算 `bodyIds`（图中 loop 后、join 前区域的全部节点）、求 `items`、`idx=0`；loop 节点**立即加入 done 集**（放行 body 的 gating），但执行记录留到循环结束再写（带累积输出）；注入 `item`（当前元素 JSON 字符串）与 `iteration`（1 起始序号）变量
2. **迭代体执行**：body 节点按 `nextReady` 正常跑（drain 循环内同步推进；shell/approval 进入 waiting 断点，回调 markDone 后在同一迭代内续跑——waiting 屏障语义天然兼容）
3. **轮次边界**：所有 `bodyIds` 完成且无 waiting → 累积本轮输出（见 6.4）→ 若 `idx+1 < items.length`：`idx++`、把 `bodyIds` 从 done 集移除、重注入 `item`/`iteration`，继续下一轮；否则进入第 4 步
4. **循环结束**：loop 节点补记执行记录（status done，output = 累积结果）、`item`/`iteration` 从环境移除（避免污染后续节点）、body 保持 done → join 自然就绪收敛，下游继续

### 6.4 输出累积（显式声明）

```js
loop.params.accumulate = [{ key: "shas", from: "shell1", field: "sha" }]
```

每轮结束时从 `node_outputs[shell1].sha` 取值追加进 `acc.shas`；循环结束 loop 节点 output 返回 `{ shas: '["a","b","c"]' }`（JSON 字符串），经 `fillEnv` 注入环境供下游 `${shas}` 引用。未声明的输出不累积（v1 不做全量聚合）。

### 6.5 回调续跑保留迭代状态（必改点）

现在 `orchestrator.markDone` 是重建快照（只带 done/waiting/environment），会把 `loops`/`node_outputs`/`trigger_raw` 全部丢光——循环体内若有 approval/ECI，回调续跑时迭代状态丢失。改为**透传快照其余字段**（spread 后只覆盖 done/waiting/status/environment）。

### 6.6 失败语义

沿用现状：body 节点 step 抛错即整执行失败（stepRun 包装层已置 failed），无新机制。

## 7. drain 循环（编排层）

- `run()` / `onEciDone()` / `onApproval()` 改调 `drainAdvance`：循环调 `advanceOnce`，遇 `waiting 非空` / `status=completed` / **本轮无任何进展（死锁护栏，本轮 done 无新增且无 waiting）** 即停
- 同步链（sql 连排、branch→join、loop 迭代）在单次 FC 调用内跑完；遇 ECI/审批自动断点、回调续跑接上——FC 短请求约束不受影响
- `state.js` 的 `advanceOnce` 保持单轮语义（既有测试锁定），drain 只存在于编排层

## 8. 后端改动清单

| 文件 | 改动 |
|---|---|
| `backend/steps/branch.js`（新） | `makeBranchStep()` 返回 `{kind:"done", output:{}}` + 3 断言单测 |
| `backend/steps/join.js`（新） | `makeJoinStep()` 返回 `{kind:"done", output:{}}` + 3 断言单测 |
| `backend/steps/loop.js`（新） | `makeLoopStep()` 返回 `{kind:"done", output:{}}` + 3 断言单测 |
| `backend/engine/conditions.js`（新） | 条件求值：JSONPath + op 比较（eq/ne/gt/ge/lt/le/contains/starts_with/ends_with/exists/empty/regex），含单测 |
| `backend/engine/dag.js` | `validateSpec` 扩展：边条件格式 + loop 区域约束；bodyIds/区域计算辅助 |
| `backend/engine/state.js` | 快照扩展（trigger_raw/node_outputs/loops）；branch 剪枝与 dead 传播；loop 迭代状态机；`run` 接收 triggerRaw |
| `backend/engine/orchestrator.js` | `drainAdvance` 循环；`markDone` 透传快照其余字段；回调后接 drain |
| `backend/index.js` | `STEP_TYPES`/steps 注册三类节点；`hydrateForRun` 传 `triggerRaw` |

## 9. 测试策略

后端（`cd backend && PATH="/usr/local/bin:$PATH" node --test`）：
- `dag.test.js`：loop 区域校验（体内嵌套控制节点拒绝、loop 直连 join 拒绝、join 入边来自区域外拒绝）、边条件格式校验
- `state.test.js`：branch 剪枝跳过 + join 收敛、无匹配全跳过仍 completed、嵌套 branch、loop 同步迭代（count/path）、accumulate 累积注入、`item`/`iteration` 变量注入与结束清理、drain 死锁护栏
- `orchestrator.test.js`：drain 循环（同步链一次 run 跑完）、waiting 时停止 drain、markDone 透传 `loops`/`node_outputs`/`trigger_raw`（循环体带 approval/ECI 回调续跑不丢迭代状态）
- 新增条件求值单测：各 op 对条件上下文树的求值
- 回归：`api.test.js` / `webhook.test.js` 等全量

前端（`cd frontend && PATH="/usr/local/bin:$PATH" npm run build`）+ 手测清单：
1. 节点库出现 branch/join/loop，点击/拖入可用
2. 画布连线后选中边 → 浮窗填条件（path/op/val），边显示徽标；无条件边显示「默认」
3. branch→shell→join：运行时未命中分支的节点显示 skipped，join 正常收敛，执行 completed
4. loop：count/path 迭代，`item`/`iteration` 在 body 可用，accumulate 输出可供下游 `${shas}` 引用
5. 校验：非法 loop 区域（体内嵌套控制节点、loop 直连 join）保存报错
6. 旧流水线执行/编辑不受影响；执行详情页 branch/join/loop 与 skipped 渲染正常
