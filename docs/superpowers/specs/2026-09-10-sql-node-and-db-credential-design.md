# CloudShuttle SQL 执行节点 + 数据库连接凭证 — 设计

日期：2026-09-10
状态：已批准（2026-09-10）

## 背景与目标

流水线现有 shell（ECI 派发执行）与 approval（人工审批）两类节点。要让流水线能编排数据操作
（数据迁移、批量订正、ETL 抽数、清理任务），需要一种**直接对数据库执行 SQL** 的节点：跑一段或多段
SQL、把受影响的量/结果某列写回变量总线供后继节点引用，并在执行详情展示执行情况。为此配套新增
**数据库连接凭证**（mysql / pg 两个 kind）。

目标：

* 新增 `sql` 节点：引用一条数据库凭证，在一个**事务**内逐条执行一组 SQL 语句，成功即提交、任一失败即回滚。
* 凭证字段：host / port / user / password / database（固定）+ `extra`（自定义额外连接参数，含 ssl），
  整体 SM4 加密存储、不回显。
* SQL 结果按节点显式声明的 `outputs[].key` 写回扁平变量环境（environment），供后继节点 `${key}` 引用。
* 执行详情能回显**已成功语句**及其影响行数，并定位到先失败的语句序号，便于排查多语句整体失败。

约束与前提：

* **后端直连执行**：不走 ECI 派发，SQL 在 FC 请求内同步执行并 `await` 完成再返回（贴合 AGENTS.md
  「对外副作用操作必须 await 完成后再返回」）。由此引入**超时兜底**，防止长 SQL 阻塞 FC 超过请求时限。
  `pg` 驱动已存在；**需新增 `mysql2` 依赖**。
* 凭证库即唯一数据库，**不做节点级 database 覆盖**（多库场景各建一条凭证引用同 host 不同 database）。
* SQL 变量插值与 SQL 文本同处**流水线作者信任边界**：作者同时编写 SQL 与决定引用哪些变量，按字面插值即可，
  不做转义/参数绑定（与编排语义一致；错误只暴露可读的失败原因与 requestId，不泄露主机/密码）。

## 一、凭证：新增 mysql / pg 两个 kind

沿用现有「一种类型一个 kind」的 `CRED_KINDS`（`frontend/src/lib/kinds.js`）模式，每个 kind 一组字段。
`credential` 表结构不变，kind 仅作数据，**无需 DB migration**。

| 字段 | mysql | pg |
|---|---|---|
| `host` | 必填 | 必填 |
| `port` | 默认 `3306` | 默认 `5432` |
| `user` | 必填 | 必填 |
| `password` | 必填（secret，SM4 加密） | 必填（secret） |
| `database` | 必填，节点使用的唯一库 | 必填，节点使用的唯一库 |
| `extra` | 选填，自定义键值对列表 | 选填，自定义键值对列表 |

**`extra`（额外连接参数，自定义多条）**：不放固定项（如 ssl），统一由用户在 `extra` 中以「键=值」对任意自定义多条，
涵盖 `ssl / charset / connectTimeout / statement_timeout / application_name / search_path` 等驱动连接选项。
后端建连时把 `extra` 合并进驱动 config，并按需做轻量类型化与常见语义映射（见「三、执行」）。`extra` 随 secret
整体 SM4 加密，敏感值同样不回显。

后端 `createCredential` / `updateCredential` 对非 dingtalk 分支走通用加密落库即可，无需改动表结构。

### 测试连接（新增端点）

凭证表单内提供「测试连接」按钮，用**草稿 secret** 调新增端点：

```
POST /api/credentials/test
{ name, kind, secret: { host, port, user, password, database, extra } }
```

* 用与保存一致的身份校验驱动连通性（不落库），失败返回可读原因（如权限/网络/驱动不支持），成功返回连接耗时。
* 测试通过只代表当前可达，**不阻塞保存**：数据库可能仅在特定网络可达，故允许先保存。
* 该端点遵循工程规则**三处成对注册**（`backend/index.js` 的 `RE.*` 正则 / `routeToHandler()` 分支 / `DISPATCH` map），
  并补 `isDispatched('credentials.test')` 断言。
* 应设为 CHROME/普通鉴权面即可（复用现有 api 鉴权），不暴露内网 `/_/` 前缀。

## 二、SQL 节点 params

```
{
  credential:  string,                 // mysql 或 pg 凭证 name（必填）
  statements:  string[],               // SQL 语句列表，逐条执行（必填，至少一条非空）
  outputs:     [{ key, column? }],     // 显式输出声明
  timeout:     number,                 // 可选，单位秒；执行阶段总超时兜底
}
```

* **`statements` 用显式列表**而非单个多行文本框：前端逐条添加，后端按数组顺序在事务内逐条执行，
  避免对 SQL 做易错的分号切分。
* 语句内支持 `${var}` 插值（来自 environment，由 `renderParams` 渲染），写变量占位符时遵守 AGENTS.md
  「占位符不得写进反引号模板字符串」约定。
* 节点不提供 database 覆盖，数据库一律取自凭证。

## 三、执行（新增 `backend/steps/sql.js` 的 `makeSqlStep`）

与 `createAdvancer` 的 `{ kind:'done', output }` 契约直接契合（对照 `state.js` 第 62-68 行：`res.output` 会被
`fillEnv` 写回 environment）。执行流程：

```
1. 解析凭证：getCredentialKind 校验 kind === 'mysql' | 'pg'；getCredentialSecrets 解密连接配置。
2. 按驱动建连（pg 用 pg；mysql 用新增 mysql2）：
   - 固定字段 host/port/user/password/database 直接映射；
   - `extra` 数组逐项合并：值做轻量类型化（数值 / 'true'|'false' / JSON 解析，否则保留字符串），
     并对少量常见语义做映射（如 `ssl=verify-ca` → 驱动 ssl 配置、`ssl=true/false` → 布尔），
     使 TLS / 字符集 / 超时等需求可当作普通自定义项开箱即用。
3. BEGIN
4. 逐条执行 statements（跳过空白语句）：
   - 每条记录执行结果（SELECT 保留最后结果集；写语句取 affectedRows / insertId）。
   - 记入该节点的执行日志："✓ [i] ...（影响 N 行）"。
5. 全部成功 → COMMIT。
6. 任一失败 → 先把【已成功语句】及其行数写入节点日志，再 ROLLBACK，最后抛出含「第 m 条失败」的可读错误。
7. 输出绑定（buildOutputs）：
   - 无 column → 最后一条语句受影响行数 affectedRows（mysql 额外含 insertId）。
   - 有 column → 最后结果集首行该列值（不存在则输出落空/为空串）。
8. 返回 { kind:'done', output, logs }，logs 供执行详情展示。
```

依赖注入方式与 `makeShellStep`/`makeApprovalStep` 一致：`makeSqlStep({ getCredentialKind, getCredentialSecrets,
createDriverPool })`，其中 `createDriverPool` 解耦驱动建连便于单测。在 `backend/index.js` 的 `steps` map
注册 `sql` 类型。

### 超时兜底

* options / 连接超时 + 语句执行总超时以 `params.timeout` 为准（驱动侧 connectionTimeoutMillis + 语句超时），
  防止长 SQL 阻塞 FC 超过请求时限（FC 冻结语义下避免任务挂起）。
* 超时视为失败：日志回显已成功语句、回滚、抛可读错误。

## 四、前端

* `frontend/src/lib/kinds.js`：`CRED_KINDS` 增加 `mysql` 与 `pg` 两条（字段/hint/icon）。
  * 固定字段 host/port/user/password/database 用现有 `fields: [{k,label,ph,...}]` 表达。
  * 新增一种字段类型来表达 `extra`（如 `{ k:'extra', type:'kvlist', label:'额外连接参数' }`），提示可添加多条「键=值」。
* `frontend/src/pages/CredentialForm.vue`：
  * 支持渲染 `kvlist` 类型字段：动态列（键 / 值输入 + 删除按钮，「添加一条」追加；键去重校验）。
  * 支持「测试连接」按钮（mysql/pg 时展示），调 `POST /api/credentials/test`，结果/错误就地展示。
* `frontend/src/pages/PipelineEdit.vue`：
  * `NODE_KINDS` 增加 `sql`（label/accent/icon）。
  * 「添加节点」区新增 SQL 节点按钮。
  * 节点编辑区：凭证下拉（仅列 mysql/pg 凭证）、`statements` 逐条添加/删除的动态列表（每条一个多行文本框，
    带 `${var}` 占位提示）、`outputs` 动态列表（key + 可选 column）、可选超时。
* `frontend/src/pages/ExecutionDetail.vue`：增加 `sql` 分支（`effType`），展示节点 logs（语句执行明细）与输出 KV。

## 五、依赖与路由

* 后端新增 `mysql2`（pg 已有）。
* 新增端点 `POST /api/credentials/test`：三处成对注册 + `isDispatched` 断言。
* `steps` map 注册 `sql` 类型。
* 无需 DB migration（凭证 kind 与节点 type 均为数据驱动）。

## 六、错误处理与安全

* 错误消息可读且不泄露主机/账号/密码/驱动内部细节；附 requestId（贴合用户偏好）。
* 密码仅存 SM4 密文、回显剔除；凭证列表/详情/节点配置均不返回 secret。`extra` 值同样随 secret 整体 SM4 加密、
  属敏感不进回显。
* SQL 插值处于作者信任边界，按字面替换，不做 SQL 注入防护（作者同时可控 SQL 与变量）；不为此引入参数化占位。

## 七、测试

`backend/steps/sql.test.js`（`node --test`，注入 fake `createDriverPool` 建连，直接驱动 `makeSqlStep` 的 `stepRun`；
输出写回可再经 `backend/engine/state.test.js` 风格的 advancer 用例验证 `output → environment` 契约）：

* 多语句全部成功 → 提交、`output` 按声明绑定、日志含各语句行数。
* 中途失败 → 已成功语句入日志、回滚、抛「第 m 条失败」；断言连接已释放。
* 输出绑定：无 column → affectedRows/insertId；有 column → 最后结果集首行该列。
* 变量渲染：`${var}` 在语句中被替换为 environment 值。
* `extra` 合并：固定字段直映射、`extra` 逐项类型化后进驱动 config（数值/布尔/JSON/字符串）、`ssl` 语义串映射正确。
* 凭证 kind 非 mysql/pg → 抛可读错误；凭证缺失 → 可读错误。
* 超时兜底：超过 timeout → 失败并回滚、日志回显已成功语句。
* 三处注册：`isDispatched('credentials.test')`。

前端：`cd frontend && PATH="/usr/local/bin:$PATH" npm run build`。

## 涉及文件清单（实施参考）

后端：

* `backend/steps/sql.js`（新增）
* `backend/steps/sql.test.js`（新增）
* `backend/handlers/api.js`（testCredentialConnection + 三处注册）
* `backend/index.js`（steps 注册 sql、DISPATCH/RE/routeToHandler 注册 test 端点、步骤上下文注入）
* `backend/package.json`（+mysql2）

前端：

* `frontend/src/lib/kinds.js`（mysql/pg kind）
* `frontend/src/api/credential.js`（+testConnection）
* `frontend/src/pages/CredentialForm.vue`（测试连接按钮）
* `frontend/src/pages/PipelineEdit.vue`（NODE_KINDS.sql + 节点编辑区）
* `frontend/src/pages/ExecutionDetail.vue`（sql 分支）

## 待办 / 决策记录

* [x] 数据库范围：MySQL + PostgreSQL
* [x] 执行机制：后端直连（引入超时兜底）
* [x] 多语句/事务：多条语句 + 单个事务（成功提交、失败回滚）
* [x] 输出：显式声明 output key
* [x] 凭证建模：mysql / pg 两个 kind
* [x] 固定字段 host/port/user/password/database；`extra` 用自定义键值对列表承载 ssl 等任意额外连接参数
* [x] SQL 录入：显式语句列表（逐条添加）
* [x] 库选择：仅凭证库，无节点级覆盖
* [x] 错误日志：回显已成功语句