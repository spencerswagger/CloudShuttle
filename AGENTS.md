# AGENTS.md —— CloudShuttle 工程规则

面向后续 AI 编码代理的约定。**违反下面任何一条都可能造成线上事故**，改动前请对照。

## 数据库迁移（最高优先级，出过线上 500）

* 项目有版本化迁移器 `backend/db/migrate.js`：按 `schema_migrations` 表记录版本，**已应用过的 NNN 文件永远不会重跑**。

* **禁止修改已存在版本的迁移文件来"更新"表结构**——那只会对全新库生效，存量库无感。要改结构一律新增 `NNN_name.sql`（幂等优先：`IF NOT EXISTS` / DO 块判断列是否存在）。

* 示例教训：曾把 `git_hook_secret` 直接改成 `webhook_secret`（只改 001），存量库仍为旧列，新代码查询即 500。正确做法是新增 `003_webhook_secret_rename.sql`，用 `information_schema.columns` 判断旧列存在才 `RENAME`（保数据），新旧并存时优先 rename 不 ADD。

* FC 自定义容器部署是 `SKIP_BOOTSTRAP=1`（跳过 entrypoint 里的 migrate/seed）：**部署后必须手动或 CI 执行一次** **`cd backend && node db/migrate.js`**，否则新迁移不生效。`deploy/README.md` 有 B.4 说明。

* 应用迁移前先想清两种库：全新库（001 起逐步应用）与存量库（跳着应用 N+1），迁移必须对两者都幂等安全。

## FC（函数计算/Serverless）执行约束

* 容器在 HTTP 响应返回后会被**冻结**，未完成的异步任务（fire-and-forget 的 `promise.catch()`）直接挂起，直到下次请求唤起才补跑。**凡是要对外部有副作用的操作（卡片状态更新、回调写库等），必须** **`await`** **完成后再返回响应**。教训：审批卡片 updateCard 不 await，用户要点两次才显示「已同意」。

* 后台定时任务/重活不要依赖"请求返回后继续跑"。需要长任务用显式机制（ECI 派发 + 回调）。

* 本地开发：系统默认 node 在此 macOS 上不可用（built for newer macOS），一律用 `PATH="/usr/local/bin:$PATH" node ...`（含 npm run build / node --test）。

## 后端路由与分发

* **新端点必须三处成对注册**，缺一必 404：① `backend/index.js` 的 `RE.*` 正则 ② `routeToHandler()` 分支 ③ `DISPATCH` map。测试 `isDispatched(name)` 遍历校验双注册，新增路由务必补断言。

* **query 参数从原始路径取，不从** **`path`** **取**：`parseEvent` 会把 `?` 之后剥掉再下传 `path`，直接 `qs(path, ...)` 恒为 null。用 `qsOf(ctx, key)`（读 `rawPath → event.path/url`，兼容 FC 的 rawQueryString 事件形态）。教训：webhook `?secret=` 一度全部读成 null → 永远 401；钉钉/ECI 回调 token/secret 同宗。

* 路径段里的百分号编码要 `decodeURIComponent`（try/catch 兜非法编码），生成端 `encodeURIComponent`，两端必须对称。教训：中文流水线名的 webhook 地址 → 500。

* 触发/回调错误码要如实回传（401/503 就是 401/503），不要用 `ok()` 把错误状态包成 200。探针把处理结果记进 `http_status` 供前端展示「能收到 ≠ 触发成功」。

## 前端 Vue 约定

* **`${name}`** **变量占位符绝不能写进反引号模板字符串**——JS 会把 `${pipeline_name}` 当插值求值，setup 阶段抛 ReferenceError 整页白屏（真实事故）。占位符一律放普通字符串拼接，或直接写进模板用 `{{ "${" + k + "}" }}`。

* 变量语法统一 `${name}`（不再是 `${{ }}` 或 `{{ }}`）。

* 内置执行元信息变量（不可被覆盖）：`pipeline_id / pipeline_name / run_no / exec_id / started_at`；webhook 映射草案生成时对同名字段做保留字避让。

* 下拉/开关/轮询等会话态：切换路由、切换 tab、卸载都要清理（clearInterval / 状态复位），防跨流水线残留与 interval 泄漏。

## webhook 命名与安全

* 触发路由是 **`/hook/webhook/:name?secret=...`**（git 类型已删除，勿再引入 `/hook/git`）。

* 管道访问密钥列 `webhook_secret`，属敏感字段：**只经** **`GET/POST /api/pipelines/:id/webhook-secret[/reset]`** **显式下发**，list/get/create/update 返显必须剔除该列（用共享 `PIPELINE_COLUMNS` 常量，别 `RETURNING *`）。

* Webhook 触发地址由后端生成（`{base}/hook/webhook/{encodeURIComponent(name)}?secret={secret}`，base 取 `CONTROL_BASE` 或请求 Host 推导），前端不拼 URL。

* 仅支持 `POST` + `Content-Type: application/json` + URL `?secret=` 鉴权，不支持签名头/HMAC。

* 流水线名称是触发地址的一部分：改名后旧地址失效，前端需提示重新复制。

## 测试与提交

* 后端测试：`cd backend && PATH="/usr/local/bin:$PATH" node --test`；前端：`cd frontend && PATH="/usr/local/bin:$PATH" npm run build`。

* 端到端路由用例要走 `handler(event)` 入口（含 query 装配），不要只测 `routeToHandler` 字符串匹配（那测不出 query/参数装配 bug）。

* 修复事故类 bug 时必须补回归测试，且测试要能"抓到旧实现"（如审批卡片更新设 `cardUpdated` 断言在响应返回时已完成）。

* 提交用 conventional commit；发布构建靠打 `v0.1.0-rcNN` pre-release tag（可在任意分支触发）。

## 当前模块速查

* 变量机制：`backend/engine/variables.js`（render/parseDeps/parseOutput/globalKeysOf/resolveScope/checkVars），静态作用域 = 全局(内置+触发源) ∪ 前驱节点 outputs。

* 引擎推进：`backend/engine/state.js`（createAdvancer），`orchestrator.js`（run/markDone 跨回调续跑 environment）。

* 触发装配：`backend/engine/trigger.js`（manual 表单 / webhook JSONPath），入口统一走 `hydrateForRun`（含 rerun）。

* 审批卡片：`backend/steps/approval.js` + `backend/handlers/hook.js`（dingtalkCardCb：先推进审批 → await 更新卡片 → 再响应）。

