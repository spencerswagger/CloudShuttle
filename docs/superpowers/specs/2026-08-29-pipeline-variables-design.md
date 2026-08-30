# CloudShuttle 流水线变量机制与触发源配置 — 设计

日期：2026-08-29
状态：待评审

## 背景与目标

当前流水线只有审批卡片靠 `{{pipeline}}/{{runNo}}` 等散落占位符做"模板替换"，且节点间无法传递数据、
触发源也没有在界面配置的位置。本项目尚未发布首版，将直接清库，不做任何向后兼容迁移。

本特性把**变量定位为执行期内所有节点间传递数据的统一总线**，而非仅为审批卡片做模板。同时新增
触发源配置（manual / webhook 两类）。

## 核心设计

### 1. 扁平变量环境（数据总线）

一次执行维护一个**扁平** **`Map<name, value>`**，叫 `environment`，与流水线定义解耦。
不区分变量出自触发源还是节点输出——消费者只按名字查 map，写入方只往 map 塞键值。**同名后写覆盖**。

变量来源分两类写入方：

* **全局变量（触发源 + 执行元信息）**：触发时写入，对**所有节点**可见。

* **节点输出**：节点执行完成写回，仅对其**后继节点**可见。

**持久化关键**：`environment` 必须并入快照（`snap:<execId>`），随 DAG 保存/续跑。审批节点 `wait` 会让
执行被多次 `advance` 断开，若扁平 map 不进快照，恢复后上游输出即丢失。

### 2. 静态作用域

对每个节点 X，从 DAG 定义静态计算其**前驱闭包**。X 的**可用变量集** =
全局变量 ∪ 所有前驱节点输出变量的总和。这一步纯静态，执行前即可算，可预览、可校验、确定性。

要求：**前置定义完整性**——引用未命名的 key、或引用非前驱节点输出，在**保存时提示并拦截**（阻塞保存）。

### 3. 节点 I/O 契约

把节点定义成「读 environment → 执行 → 写回 outputs」的通用单元，框架在 `advance` 层统一处理：

1. `stepRun(node, ctx)` **执行前**，对节点 `params` 中的字符串字段做 `${name}` 模板替换（查扁平 map）。
2. 节点执行后，把命名输出写回 `environment[name]`（同名即覆盖），随快照落库。
3. 每个节点提供**默认输出 key**（供快速使用）；用户可自行改名（规避覆盖）或保留同名（主动覆盖）。

* shell 节点：脚本运行时把 environment 注入为环境变量（脚本内可用 `$VAR`）；K=V 输出解析写回扁平 map。

* 审批节点：本期仅消费不产输出；契约保留，未来新节点类型只需实现读写即可接入总线。

### 4. 触发源（收敛为两类）

#### A. webhook（含 git）

有触发请求 body，靠「变量映射项」提值。触发源声明一组映射项 `[{ name, jsonPath }]`，运行时从触发
请求 body 按 JSONPath 取值写入扁平 map（只取映射的 key，不取整段 body）。

git 平台事件并无统一协议——因此 git 就是 webhook 的一种，用同一套 JSONPath 映射解决。为常见平台提供
**默认映射模板**（GitHub / GitLab，如 `git_ref = $.ref`），用户一键套用再改。`name` 建议前缀（如
`git_ref`）降与输出 key 的碰撞。

#### B. manual（formily 兼容 schema）

无请求 body，触发参数在**定义时预置**一组 formily 兼容 schema，运行时按清单填表。schema 同时是渲染元数据：

```json
[
  { "key": "branch", "title": "分支", "type": "string", "description": "要发布的目标分支",
    "default": "main", "required": true },
  { "key": "env", "title": "环境", "type": "string", "enum": ["prod", "staging", "dev"], "default": "staging" },
  { "key": "note", "title": "备注", "type": "text", "description": "发布说明" }
]
```

字段对齐 formily 常用属性：`type`(string/number/boolean/text/enum)、`title`、`description`、`default`、
`required`、`enum`、placeholder 等。**渲染层**：schema 完全兼容 formily，但本期前端用项目现有控件按 schema
渲染（不引入 @formily 运行时）；未来独立触发表单可复用同一份 schema。

#### 统一落点

两类触发源最终都汇成同一个扁平 kv 写入 environment，与节点输出同一张 map（同名后写覆盖）。

### 5. 执行元信息变量

把触发即知、与执行相关的元信息也作为预设全局变量写入扁平 map（对所有节点可见）：
`pipeline_id`、`pipeline_name`、`run_no`、`exec_id`、`started_at`。
审批卡片不再依赖专属 `loadExecMeta`，直接消费同一张 map。

### 6. 渲染与消费

- 统一语法 **`${name}`**（name 即扁平 key）。不做 `{{ }}` 临时兼容——清库，仅保留新语法。
- 渲染点：触发入口解析（manual 清单赋值 / webhook 映射项取值）写入 map；节点 `stepRun` 前替换；审批卡片正文渲染。
- 现有审批卡片 `loadExecMeta` 与 `{{pipeline}}/{{runNo}}` 占位符逻辑删除，改用变量地图与 `${<var>}`。

### 7. 静态校验（保存时）

保存流水线时做静态检查，引用未知 key / 引用非前驱输出 → **提示并拦截**（不保存）。
校验依据：触发源已声明的全局变量 + 各节点前驱输出的并集。此校验是唯一守卫（本次不做运行期防注入）。

### 8. 前端 UI

**触发源区**（流水线编辑页，节点画布上方）：

* **manual**：参数 schema 编辑器——增删改 `{key,title,type,enum,default,required,description,placeholder}`，
  type 映射到项目现有控件（string/text/enum/number/boolean），不引入 @formily 运行时。

* **webhook**：展示/复制该流水线的 webhook URL（地址由后端生成，鉴权沿用**该管道独立的 `webhook_secret`**，
  经 URL query `?secret=` 携带；密钥只在 `webhook-secret` / `webhook-secret/reset` 接口显式下发，
  常规管道返显不含它。能力边界：仅 `application/json` body + URL secret，不支持签名头）；平台模板下拉
  （GitHub / GitLab 一键套 JSONPath）+ 映射项列表 `(name, jsonPath)`。

**运行弹窗**：按 manual schema 用现有控件渲染表单，填值后注入并触发执行；webhook 触发走 URL。

**节点间传输辅助**：shell 节点每个输出 key 提供默认值；编辑 `command`/`env`/审批正文时右侧提示
「可用变量」（触发源已声明 + 该节点前驱输出），点选插入 `${}`。可用变量列表与保存校验共用同一份
静态作用域计算结果，保证提示与校验一致。

## 兼容清理清单（顺带删除）

由于清库不兼容，以下旧版 shim 一并清除：

* `dingtalk-corp.js`：数组/逗号字符串两种存储形态归一；删 `callbackUrl` 兼容旧签名。

* `hook.js`：回调决策归一为单一标准，删 `action`/`decision` 双命名兼容。

* `api.js`：删 `resolveMobiles` 的"保留签名兼容引用"注释/死代码。

* 前端列表「详情 404 回退列表查找」逻辑：详情接口已具备，删除回退（`PipelineEdit.vue`/`CredentialForm.vue`/`ImageForm.vue`）。

* `migrations/001_init.sql` 中"存量库兼容"注释与幂等补充项：清库后按干净结构重写。

* 遗留：`approval.js` 旧 `extractDecision` 兼容分支、`loadExecMeta` 字符串/对象双形态 trigger —— 一并归一。

## 依赖

* `jsonpath-plus`（前端/后端触发解析用，随构建打包，无外部 CDN）。

## 范围边界

* 不做：定时触发（FC 无请求不触发，schedule 已删除）、触发源变量跨执行持久化复用（仅本次执行）、
  全局 secrets / 自定义 vars（当前档位仅"触发源 + 上游输出"）。

* 节点类型：本期 shell（执行 + 输出）、审批（消费）接入总线。

## 验收标准

1. 流水线定义新增 trigger（manual schema / webhook 映射项）与每个节点的默认输出 key。
2. 手动运行弹窗按 manual schema 渲染表单，填值作为全局变量注入；节点能引用。
3. webhook（含 git）请求 body 经 JSONPath 映射产出变量，节点可引用。
4. 节点输出的 K=V 写回扁平 map，后继节点可用 `${name}` 引用。
5. 保存时引用未知/非前驱 key 被拦截并提示。
6. 审批卡片消费同一变量地图渲染正文。

