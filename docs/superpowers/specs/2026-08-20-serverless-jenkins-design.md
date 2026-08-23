# Serverless 工作流编排平台（Serverless Jenkins）设计文档

- 日期：2026-08-20
- 状态：草稿（待用户审阅）
- 范围：首版（MVP）整体设计

## 1. 背景与目标

我们需要一个"无服务器版、类似 Jenkins/n8n"的云原生 CI/CD 工作流编排平台。它不维护任何常驻业务实例：**闲时缩到 0，被触发时冷启动拉起**，最大化节省云资源开销。核心载体是阿里云 Serverless 产品族（FC / ECI）。

目标场景（首版）：git 仓库 webhook 触发 → 拉取代码并构建 → 钉钉审批卡点 → 推送 Docker 镜像或其他制品 → kubectl 升级镜像。同时保留扩展能力以支持更多常见工作流。

### 非目标（郑重砍掉）
- 不做通用定时/消息队列/数据库订阅等多元化触发源，首版只做 HTTP 触发（git webhook、钉钉回调、内部回调）。
- 不做可视化拖拽布局引擎的复杂交互，首版 Web 画布以"表单化节点配置 + 连线"的轻量交互为主，渲染与持久化聚焦稳定。
- 不做多租户/SaaS 计费体系，面向单个团队自用。
- 不封装云账号体系，AK/SK 通过环境配置注入。

## 2. 硬约束（来自产品选型）

1. 函数计算实例冷启动即拉起，**无调用时实例数为 0**（FC 天然满足）。
2. FC 提供的运行时**限制为 Node.js**，因此控制面代码用 Node。
3. FC 对常规 shell 命令有严格限制（无完整 root/shell 环境），因此**任何需要 shell / docker / 构建 / kubectl 的重活，不得落在 FC**。
4. FC 调用结束即释放实例，**不支持长驻进程**；长任务交给其他载体。
5. Redis 与 PostgreSQL 为**环境提供的有状态服务**，本项目只负责配置连接串，不在开发范围内。

## 3. 总体架构

系统拆为两大部分，职责截然分离：

```
┌─ 前端 Vue3 画布（静态资源，挂 CDN，空闲 0 成本）────────────────────┐
└───────────────┬──────────────────────────────────────────────────┘
                │ REST (管道 CRUD / 执行历史 / 画布数据)
                ▼
┌──────────── 管理平台端（控制面 = 单一 FC Web 函数）─────────────────────────┐
│  Node + 自定义域名路由，一函数多接口：                                   │
│   /api/*      管道定义 CRUD、执行历史查询、Web 画布数据                 │
│   /hook/*     外部 hook：git webhook、钉钉审批回调                     │
│   /_/hook/*   内部 hook：ECI 执行完成通知、审批内部流转                │
│                                                                      │
│  职责：无状态 API 编排 + DAG 状态机"一次推进" + 派发 ECI + 状态落库  │
└──────────────┬──────────────────────────┬───────────────────────────┘
               │ 派发一次性任务(ECI)         │ 读写
               ▼                            ▼
   ECI 弹性容器（执行器端）          Redis(状态/锁) + PostgreSQL(定义/历史)
   完整 shell，按需拉起，跑完销毁         （二者为环境提供）

```

关键设计要点：
- **控制面（管理平台 FC）只做短请求、无状态**：收到触发 → 推进 DAG 一步 → 派发 ECI 或登记等待 → 写入状态 → 返回释放。实例空闲归 0。
- **执行器（ECI 容器）承担所有重活**：拉码、构建（含 Docker 镜像）、推制品、kubectl 升级。容器有完整 shell，天然规避 FC 的 shell 限制。
- 真正"持续存在"的东西只有 Redis/PG（环境提供）和短时 ECI 容器（按秒计费），**没有任何常驻业务主机**。

## 4. 节点模型

工作流由图（DAG）构成。节点**只分两种类型**，类型决定"是否派发 ECI"：

| 节点类型 | 说明 | 载体 | 推进方式 |
|---|---|---|---|
| **执行节点 `shell`** | 给定镜像 + 用户自定义 shell 命令，跑一次即结束。git 拉码、构建、推镜像/制品、kubectl 升级等**全部由用户在此用命令完成** | ECI 容器 | FC 派发 ECI 一次性任务，登记内部回调地址后释放 |
| **状态节点 `approval`** | 等待外部事件、不占计算资源的步骤：钉钉审批卡点 | 无（仅依赖外部 hook） | FC 登记 hook 回调地址后释放，外部事件到达再唤醒 |

### 执行节点 `shell` 参数
| 参数 | 说明 |
|---|---|
| `image` | 执行镜像。可从系统**预置镜像列表**选，也可自由填任意镜像 tag |
| `command` | 用户多行 shell 脚本（`git clone`、`docker build/push`、`kubectl set image`、`s3cmd`…自由编写） |
| `env` | 环境变量，可**引用凭证**（见凭证机制）、可引用前序节点输出（如镜像名、提交号） |
| `resource` | CPU / 内存（默认值，可调） |
| `timeout` | 单节点超时（默认值，可调） |
| `workdir` | 容器工作目录 |

### 预置镜像（可后台管理）
系统预置常用执行镜像，用户可一键选用，也可填任意 tag；后台可增删预置列表。
- 语言运行环境：`node:20-alpine`、`golang:1.23`、`python:3.12-slim`、`eclipse-temurin:21-jdk` 等
- 工程链：`docker:27`（带 git，可 build/push）、`kubectl` + 目标集群凭证、`aws/s3cmd`（S3 兼容对象存储）
- `build.artifact` 依赖不同编程语言版本 → 用户在节点里自选对应语言镜像即可

### 凭证机制（credential）
`push.image` 的镜像仓库账号密码、`push.artifact` 的 S3 AK/SK 等敏感信息**不直接写在节点里**，统一由平台维护**凭证库**，节点以 `env` 引用注入：
- 凭证中类：`docker-registry`（registry 地址 + 账号 + 密码/Token）、`s3`（endpoint + AK + SK）、`git-token`、`kubeconfig`（预留）
- 节点 `env` 声明引用某个凭证后，FC 派发 ECI 时把对应值以环境变量注入容器，供用户命令使用（如 `docker login`、`s3cmd --access_key=$AK --secret_key=$SK`）
- 凭证永不落盘到执行日志；控制面侧存储用国密 SM4 加密，页面回显一律打码

> 效果：首版节点类型仅 `shell` + `approval` 两种。新动作不需要新增代码类型，改动脚本即可。

## 5. hook 路由与回调机制

FC 按路径语义区分触发来源，全部收敛在一个函数内：

| 路由 | 定位 | 典型来源 | 作用 |
|---|---|---|---|
| `/hook/git/{pipeline}` | 外部 hook | GitHub/GitLab/Codeup push 或 tag | 创建执行、进入 DAG 起点 |
| `/hook/dingtalk/{token}` | 外部 hook | 钉钉卡片"通过/拒绝"回调 | 推进状态节点（审批卡点） |
| `/_/hook/ecidone/{execId}` | 内部 hook | ECI 容器执行结束通知 | 推进执行节点 |
| `/_/hook/fail/{execId}` | 内部 hook | ECI 容器失败/超时 | 走失败分支 |

- 所有触发都汇入**同一个"唤醒 → 一次推进"循环**。
- 回调 token 由 FC 生成并随派发下发，FC 侧校验 token 防伪，再推进对应执行。
- `/hook/git/{pipeline}` 中的 `{pipeline}` 使用管道的唯一 name（`pipeline.name` 需加唯一约束），避免在 URL 中暴露内部 id。

## 6. 执行状态机（异步回调续跑）

核心机制：**FC 每次被唤醒只做"推进 DAG 到下一个等待点"，然后释放**；真正的"存活"由 ECI 和 Redis/PG 承担，不与 FC 生命周期绑定。

```
MEV = 管理平台引擎（FC 函数的一次调用）
唤醒来源：/hook/*  或  /_/hook/*  或 手动触发 /api/exec/create
   │
   ▼
MEV: 载入 Redis 快照(execId) → 校验 → 推进 DAG 到下一个可执行点
   │
   ├─ 命中 执行节点 → 派发 ECI(登记回调用 _/hook/ecidone/{execId}, 存快照) → 返回释放
   ├─ 命中 状态节点 → 发钉钉审批(登记 /hook/dingtalk/{token}, 存快照)      → 返回释放
   └─ 无等待节点   → 就地同步完成(幂等写状态) → 存快照 → 仍可推进则继续/否则结束
         ▲
         │ ECI 完成回调 / 审批回调
         └─ 唤起新 MEV → 循环
```

要点：
- **快照即断点**：每次推进结束，把执行上下文（当前节点、已完成步骤的输入输出、进度）序列化写 Redis，作为下次续跑的起点。
- **一次推进原则**：无论哪类节点，MEV 都尽量在单次调用内完成决策并返回，避免 FC 长驻。
- **失败与超时**：执行节点失败走 `/_/hook/fail`；审批超时由定时巡检（可用 FC 定时触发器，首版可简化为"仅记录待处理，不主动关停"）。
- **幂等**：ECI/回调可能重试，FC 以 execId + nodeId 做幂等去重（Redis 锁 / 状态检查）。

### 执行状态
`created → pending → running → approved_pending / building → succeeded | failed | canceled`

## 7. 数据模型

采用 PostgreSQL 存"定义与历史"，Redis 存"运行时瞬时状态与锁"。

### PostgreSQL（持久、需查询）
- `pipeline`：管道定义（id, name, description, spec_json(DAG), rev, createdAt, updatedAt）
- `pipeline_rev`：定义版本快照（用于追溯某次执行用的哪一版）
- `execution`：执行记录（id, pipelineId, baseId, runNo, status, trigger(JSON), context(JSON), startedAt, finishedAt）
- `execution_node`：节点执行明细（execId, nodeId, step, type, status, input, output, startedAt, finishedAt）
- `webhook_registry`：hook 回调凭据映射（token→execId+nodeId+type, expiresAt）
- `credential`：凭证库（id, name, kind(docker-registry/s3/git-token/kubeconfig), secret_enc(SM4), createdAt）—— 敏感字段 SM4 加密存
- `exec_image`：预置执行镜像（id, name, image, category, builtin, createdAt）—— 后台可管理

### Redis（运行时瞬态）
- `snap:{execId}`：执行上下文快照（断点）
- `lock:{execId}:{nodeId}`：幂等锁
- 审批超时标记、节流计数等瞬态量

## 8. 接口清单

### API（管理平台 `/api/*`）
- `GET/POST/PUT/DELETE /api/pipelines`
- `GET /api/pipelines/{id}/revs`
- `POST /api/executions`（手动触发一次执行）
- `GET /api/executions`、`GET /api/executions/{id}`、`GET /api/executions/{id}/nodes`
- `GET /api/executions/{id}/logs`（日志，可转发自 OSS/SLS）
- `POST /api/pipelines/{id}/debug`（干跑/落盘校验 DAG）
- `GET/POST/PUT/DELETE /api/credentials`（凭证库管理，敏感字段写入不回显）
- `GET/POST/PUT/DELETE /api/images`（预置执行镜像后台管理）

### 触发 Webhook
- `POST /hook/git/{pipeline}`（第三方签名校验）
- `POST /hook/dingtalk/{token}`
- `POST /_/hook/ecidone/{execId}`、`POST /_/hook/fail/{execId}`（内部校验）

### 前端
- 管道画布（节点配置 + 连线，存取 `pipeline.spec_json`；shell 节点编辑镜像/命令/环境引用，approval 节点编辑审批人/文案）
- 凭证管理页（增删改 docker/s3 等凭证，编辑时回显打码）
- 预置镜像管理页（后台增删）
- 执行历史列表 + 详情 + 日志页 + 审批卡点可视化

## 9. 技术选型

| 层 | 选择 | 理由 |
|---|---|---|
| 控制面 | FC Web 函数（Node） | 一函数多接口、缩 0、短请求无状态 |
| 执行器 | ECI 弹性容器（按需 Job 风格） | 完整 shell、任意镜像、按秒计费、结束销毁 |
| 前端 | Vue 3 + Vite | 用户偏好现代前端栈；静态资源挂 CDN |
| 存储 | PostgreSQL + Redis | 用户既有栈；由环境提供 |
| 网关 | 云 API 网关 / FC 自定义域名 | 收敛路由、鉴权、签名校验 |
| 安全 | 国密 SM3/SM4 用于敏感数据与 webhook 签名（JWT 认证兼容需保留 RS256） | 用户安全约束（除兼容场景外一律国密） |

## 10. 部署拓扑与计费特征

```
静态页面(CDN)                        管理平台FC(缩0)                   执行器(ECI)
    │                                     │                              
    │ 画布/历史(浏览器)                     │  派发任务/登记回调              
    └──────────────► /api/* ─────────────► ┼───────────► 按需拉起Job容器
        git平台 ──► /hook/*                │                                          
    钉钉审批 ──► /hook/*                    │◄────────── 结果(push)  _/hook/ecidone
    ECI结果 ──► /_/hook/*                   │
                              [PG] [Redis]
```

计费特征：空闲时仅 CDN + Redis/PG 计费（近 0）；有触发时按 FC 调用次数与 ECI 运行时按秒计费。

## 11. 首版范围（MVP 验收清单）

必须支持：
1. 前端画布可创建/配置管道（节点仅两类：`shell` 执行节点含镜像选择/命令/凭证 env 引用、`approval` 审批节点），保存到 PG。
2. 凭证库可管理（docker-registry/s3 等），shell 节点可引用并注入环境变量供命令使用。
3. git push/tag webhook 触发执行，执行经 ECI 以用户 shell 命令依次完成构建与部署。
4. 钉钉审批卡点可暂停/续跑（推送审批卡片，通过后断点继续，拒绝则失败）。
5. 执行历史可在前端查看（状态、节点明细、日志）。

明确不做（首版）：
- 定时触发、多重触发源合并
- 可视化拖拽多分支/并行(parallel)高级编排（DAG 串行为主，保留扩展）
- 审批超时主动关停、多团队权限体系
- 复杂日志检索（先对接易存即取）

## 12. 风险与后续扩展

- **ECI 冷启动**：拉镜像/初始化有一定延迟，考虑镜像预拉取或仓库内存预热。
- **构建时长与配额**：长构建应设置 Job 超时与资源上限。
- **幂等与重试**：回调重试需 Redis 幂等锁兜底。
- **扩展点**：新 step 只需在 registry 注册；后续可加并行节点、定时触发、更多执行器载体（SAE 任务/ACK Serverless）。