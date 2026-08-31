# CloudShuttle Shell 执行节点 — 设计

日期：2026-08-31
状态：待评审

## 背景与目标

流水线目前只有审批节点（消费变量、不发执行任务）。要让流水线真正"能干活"，需要一种在
弹性容器（ECI）里跑用户命令、并把结果写回变量总线的节点类型。本设计定义 **shell 节点**的完整
执行链路、前端配置与测试策略。

目标：

* 用户在节点上配一段 shell 脚本 + 可选用环境，控制面在 ECI 一次性容器内执行，跑完即销毁、按秒计费。
* 脚本能将 K=V 输出写回扁平变量环境（environment），供后继节点引用；日志回传控制面供执行详情展示。
* 收敛到**统一 runner 入口**，避免为每种语言镜像重复造轮子。

## 执行链路（后端 + runner）

整体：**runner 统一入口 → 拉取 job → 跑用户命令 → 输出与日志分离回传 → 回调写回变量总线**。

### 1. 统一 runner 入口

shell 节点在 ECI 中始终以 **`cloudshuttle/runner`** 镜像启动（`ENTRYPOINT=run.sh`）。该镜像内置
`git / docker CLI / kubectl / s3cmd / jq / curl`（见 `runner/Dockerfile`），作为执行工具链环境。

> 本期 ECI 容器镜像即 runner：用户不直接选择 node:20 等语言镜像进 ECI（它们没有 run.sh 引导）。
> 需要其它语言/工具链，用 runner 内的 `bash -lc "..."`、docker、或后续提供的自定义 runner 镜像解决。

### 2. 新增 job 拉取端点

run.sh 启动后从控制面拉取本次 job 定义，而非靠容器启动参数塞长文本，便于统一鉴权与大段命令下发：

```
GET /_/hook/job/:token
```

* 内网回调（`/_/` 前缀），来源仅限内网 IP（沿用 AGENTS.md 既有规则）。
* 用 `webhook_registry` 里登记的 `token`（kind=`eci`）+ 校验 `expires_at`，node 必须处于等待态。
* 返回本次 job：`{ command, timeout, outputKeys, env }`。
  * `env` 兜底冗余：控制面派发时已把 environment 注入 ECI 容器 env（`shell.js envToEntries` + `p.env` 在前、
    environment 在后同名覆盖），此处再给一份，供 run.sh 校验/注入凭证类敏感变量时用。
* 该端点与 eciDone/eciFail 一并三处成对注册（`RE` 正则 / `routeToHandler` / `DISPATCH`）。

### 3. 输出文件与日志分离回传

run.sh（改造）流程：

1. 拉 job → 把 `command` 写入 `/tmp/cmd.sh`。
2. 执行时做输出/日志分离：
   * `stdout/stderr` 重定向追加到 `/tmp/job.log`（日志）。
   * 结果通过 **job 注入的输出文件**回传：run.sh 把 `CLOUDSHUTTLE_OUT_FILE`（默认 `/tmp/out`) 导出为环境变量，
     命令可向其中写 K=V 行实现变量写回；若未声明输出 key，run.sh 直接把解析后的输出对象整体当作默认输出 `step_out`。
3. 成功后回调（body 带 `result`）：

```
POST {CB_BASE}/_/hook/ecidone/{EXEC_ID}?token={TOKEN}&secret={SECRET}
{ "result": { "output": { "k1":"v1", ... }, "logs": "<job.log 内容>" } }
```

> 大小上限：logs/output 过大时截断（本期 N KB 上限），不做流式日志。

### 4. 回调写回变量总线

* `internal.eciDone` 透传 `result.output` 与 `result.logs` 给 `orchestrator.onEciDone({execId, nodeId, output, logs})`
  （当前实现只传 execId/nodeId，需补 result 透传）。
* `onEciDone`：`markDone` 标记节点成功 → 把 `output` 解析为扁平 KV 并入 `environment`
  （对后继节点可见，`buildEnv(next.environment, parsedOutput)`，向后继 `advance` 传递）→
  `record({ status:"succeeded", output, logs })` 落库供详情展示 → 继续推进后继节点。
* **FC 执行约束**：回调内的写库/推进/`record` 等对外副作用一律 `await` 完成后再返回响应，避免容器冻结丢掉。
* `outputKeysOf(p)`（已实现）作为节点声明输出 key 的单一来源，作用域推断（`resolveScope`）与其保持一致。

## Shell 节点参数（p）

| 字段 | 类型 | 说明 |
|---|---|---|
| `image` | string | 选用哪个 runner 工具链镜像（默认 `cloudshuttle/runner`） |
| `command` | string | 多行 shell 脚本，支持 `${name}` 引用变量 |
| `env` | [{k,v}] | 附加环境变量（K=V，可引用 `${}`）；节点自身 env 在前、environment 在后同名覆盖 |
| `resource`/`timeout` | object/int | ECI 规格与执行超时（沿用现有 `eciProvider.dispatch` 签名） |
| `outputs` | [{key}] | 声明的输出 key（可空 → 默认单 key `step_out`） |
| `params` 内字符串 | — | `stepRun` 执行前统一做 `${name}` 模板替换 |

## 前端配置 UI

* **节点画布 shell 节点配置面板**（复用现有 `PipelineEdit.vue` 类型化配置区）：
  * 镜像：从预置 runner 镜像下拉选择（`images.json`），支持自定义镜像 URI。
  * 命令：多行脚本 textarea（等宽字体）。
  * 附加 env：K=V 键值对列表（增删改）。
  * 资源（内存/规格）与超时输入。
  * 输出 key 列表：默认 `step_out`，可编辑 key。
* **可用变量提示**：编辑 `command` / `env` 时右侧提示「可用变量」（触发源已声明 ∪ 该节点前驱输出），点选插入 `${}`——
  复用静态作用域结果，保证提示与保存校验一致（沿用变量机制既有约定）。
* **执行详情日志**：execution detail 页展示该节点 `logs`（脚本输出）与解析后的 `output` KV。

## 失败与超时

* run.sh 退出码非 0 / ECI 容器失败 → 回调 `/_/hook/fail/`（secret 鉴权），`onEciFail` 标记该节点失败并终止整个执行（沿用现状）。
* 超时：`timeout` 传递给 ECI，超时按失败处理并在日志注明。

## 测试策略

* **后端单测**（`backend && node --test`）：
  * `outputKeysOf`：显式输出优先、空则默认 `step_out`。
  * job 拉取端点：合法 token 返回 job 定义；无效 token/过期/节点非等待态 → 403/401；走 `handler(event)` 入口含 query 装配。
  * `eciDone`：透传 `result.output`/`result.logs`，401 token 不匹配。
  * `onEciDone`：解析 output 并入 environment，**断言后继节点可见写回值**（回归测试要能抓"旧实现"——类比审批卡片需点两次的教训：断言在响应返回时 environment 写回已发生）。
* **前端**：`npm run build` 通过；配置面板手测命令/输出 key 编辑、可用变量点选。
* **端到端**：runner 镜像本地构建后用样例 job 手动验证 输出文件 + 日志分离回传。

## 范围边界

* 本期不做：日志流式/分段拉取、多镜像并行、runner 内 credential 直连注入（凭证解引用留待后续）、
  webhook 触发 shell（沿用 manual/webhook 统一变量机制，本节点只消费 environment）。

## 验收标准

1. shell 节点配置面板可配镜像/命令/env/资源/超时/输出 key，命令支持 `${name}` 变量。
2. ECI 以 runner 统一入口执行，脚本可向输出文件写 K=V 实现变量写回，后继节点能引用。
3. 执行日志回传并展示在 execution detail 页。
4. eciDone/eciFail/job 三端点按三处成对注册；回调写库与推进在响应返回前完成。
5. 失败/超时按失败终态终止执行且日志可查。
6. 回归测试覆盖"回传 output → environment 写回 → 后继可见"全链路。