# 部署手册

本平台只有**两种**部署方式：

| 方式 | 控制面 | 数据库 / Redis | 执行器(ECI) | 适用 |
|---|---|---|---|---|
| **A. docker compose（本机）** | 本地容器（可加载 release 镜像） | 本地容器（也可换云） | 阿里云 | 开发 / 演示 |
| **B. 云端部署（纯阿里云）** | FC（函数计算） | 云 RDS / 云 Redis | 阿里云 | 生产 |

> 无论哪种方式，**执行器（ECI）始终走阿里云**——它是按需拉起的容器，本机起不来。

---

## 0. 获取发布产物（无需自行打包）

到 **GitHub Release**（<https://github.com/spencerswagger/CloudShuttle/releases>）按 tag（如 `v0.1.0`）下载两个资产：

| 资产 | 内容 | 用在哪 |
|---|---|---|
| `cloudshuttle-backend-<tag>.tar` | 控制面后端镜像（docker tar） | 方式 A：`docker load`；方式 B：FC 自定义容器镜像 |
| `cloudshuttle-web-<tag>.zip` | 前端静态包 | 方式 B：上传 OSS/CDN |

这些资产由 GitHub Action 在打 tag 时自动产出。若要**自己打包源码**（本地开发 / FC 代码包 / 改镜像），见各子 README：

- **后端（控制面）打包** → [backend/README.md](../backend/README.md)（FC 代码包 / 镜像两种打包）
- **前端打包** → [frontend/README.md](../frontend/README.md)
- **执行器 runner 镜像** → [runner/README.md](../runner/README.md)

---

## 方式 A：docker compose（本机）

只需 Docker，一条命令起全部；ECI 仍用阿里云。

```bash
# 1.（可选）加载发布的后端镜像；不加载则 compose 自动从源码构建
docker load -i cloudshuttle-backend-<tag>.tar

# 2.（可选）覆盖环境变量（不建也能用默认值启动）
cp deploy/env.example .env

# 3. 构建并启动（首次自动 build 前端 + 迁移/seed）
docker compose up -d --build

# 4. 访问
#    前端画布  http://localhost:8080
#    控制面API http://localhost:9000/api/pipelines
#    状态/日志 docker compose ps | logs -f backend
```

`docker-compose.yml` 里 `backend` 服务默认用 `cloudshuttle-backend:<tag>` 镜像（`BACKEND_TAG`，默认 `0.1`）：**已 `docker load` 到本地则直接用镜像，否则自动从源码构建**。`frontend` 始终从源码构建为 nginx 容器（托管前端并把 `/api` `/hook` `/_/hook` 反代到 backend）。

**需要填的变量（`.env`，都有默认值，不填也能起服务）：**

| 变量 | 默认 | 说明 |
|---|---|---|
| `SM4_KEY` | 空 | 仅用凭证库（审批机器人/私有仓库/S3）时**必须**填；留空则禁止存凭证 |
| `CONTROL_BASE` | 空 | 回调用绝对地址；留空自动从请求 Host 推导（本机= `http://localhost:8080`） |
| `ALIYUN_AK/SK/REGION` | 空 | 传给 ECI 的执行器用；起服务不需要，跑 shell 节点才需要 |

**限制**：本地容器跑的是控制面与数据库；shell 节点仍下发到**阿里云 ECI**，因此端到端跑 `demo-rollout` 仍需阿里云凭证与 `createEciGroup` 真实接入（见"执行器接入点"）。

---

## 方式 B：云端部署（纯阿里云托管）

### B.1 准备阿里云资源

| 资源 | 用途 | 说明 |
|---|---|---|
| 云数据库 RDS PostgreSQL | 定义/执行历史 | 记下连接串（B.3 有示例） |
| 云数据库 Redis | 状态快照/锁 | 记下连接串（B.3 有示例） |
| FC（函数计算，自定义容器） | 控制面 | 镜像部署（自定义容器/Web 服务），监听 :9000，需 `SKIP_BOOTSTRAP=1` |
| OSS + CDN | 托管前端 | 静态桶，接 CDN |
| 容器镜像 ACR | 控制面镜像 + 执行器镜像 | backend tar 与 runner 镜像推送位 |
| 云容器 / ECI 权限 | 拉执行容器 | 见"执行器接入点" |

### B.2 控制面：FC（自定义容器）

后端以「自定义容器/Web 服务」跑在 FC，监听 `:9000`，提供全部 API。

1. **建函数**：镜像选 ACR 的 `<ns>/cloudshuttle-backend:<tag>`；监听端口 `9000`，健康检查路径 `/healthz`。
2. **网络**：FC 的 VPC 选与 RDS 相同，RDS 白名单加入该网段；Redis 同理。
3. **环境变量**：见 B.3（务必配置，含 `SKIP_BOOTSTRAP=1`）。
4. **首次迁移/seed**：`node backend/db/migrate.js` + `psql "$PG_URL" -f deploy/seed.sql`（因 `SKIP_BOOTSTRAP=1` 已跳过）。
5. **绑定自定义域名**并写入 `CONTROL_BASE`。

> 备选：FC 走函数代码包（`index.js` 的 handler），见 [backend/README.md](../backend/README.md)。

### B.3 环境变量（全局填这些）

在 FC 环境变量里逐行设置（替换 `<…>` 为自己的值）：

```
PG_HOST=cp-prod-8abcq0xyz.pg.rds.aliyuncs.com
PG_PORT=5432
PG_DB=cloudshuttle
PG_USER=cloudshuttle
PG_PASSWORD=<你的RDS密码>
REDIS_URL=redis://:<你的Redis密码>@cp-prod-rq7d1xyz.redis.rds.aliyuncs.com:6379/0
SKIP_BOOTSTRAP=1
PORT=9000
CONTROL_BASE=https://cloudshuttle.example.com
SM4_KEY=a1b2c3d4e5f60718293a4b5c6d7e8f90
ALIYUN_AK=<你的AK>
ALIYUN_SK=<你的SK>
ALIYUN_REGION=cn-hangzhou
```

- 公网 Redis（TLS）把 `redis://` 换成 `rediss://`；
- `SKIP_BOOTSTRAP=1` 跳过建表/seed，需先手动执行一次 `node backend/db/migrate.js` + `psql "$PG_URL" -f deploy/seed.sql`；
- 完整变量作用见 `deploy/env.example`。

### B.4 前端 → CDN（用 release 的 web zip）

```bash
unzip cloudshuttle-web-<tag>.zip -d cloudshuttle-web    # 解压即 `dist/` 内容
```

- **部署物**：把解压出的**整个目录**上传到这个静态 OSS 桶，开启**静态网站托管**，接 CDN；
- 入口文件是 `index.html`；
- **CDN 无反代**：把目录里的 `cloudshuttle-config.js` 的 `apiBase` 改成控制面完整地址后再上传：
  ```js
  window.CloudShuttleConfig = { apiBase: "https://你的控制面域名/api" };
  ```
- 自建打包见 [frontend/README.md](../frontend/README.md)。

### B.5 执行器镜像（runner → ACR → ECI）

完整构建与推送见 [runner/README.md](../runner/README.md)，要点：

```bash
docker build -t registry.cn-hangzhou.aliyuncs.com/<ns>/cloudshuttle-runner:0.1 runner/
docker push registry.cn-hangzhou.aliyuncs.com/<ns>/cloudshuttle-runner:0.1
# 并把 seed 里 "Docker+Git 构建" 镜像改指向 ACR 地址（默认 cloudshuttle/runner:0.1）
```

### B.6 审批机器人（可选）

审批卡点用**钉钉**发送，支持两种凭证：

1. **群自定义机器人（webhook）**：审批卡点用 `actionCard` 两个按钮，点击后在钉钉内置 webview 回调后端续跑。无需企业应用与额外权限。凭证页创建 `dingtalk` 凭证（webhook + 可选加签 secret），节点填 `params.robot`。
2. **企业机器人（推荐，可后台回调）**：走官方互动卡片，按钮点击由**钉钉服务器后台回调**（不进浏览器）。凭证页创建 `dingtalk-corp` 凭证（企业应用 AppKey/AppSecret/AgentId/RobotCode）。审批节点可配置**发群**（填 `openConversationId`）或**发成员**（从通讯录按部门树勾选）。

**企业机器人所需的企业应用权限**（在钉钉开发者后台「权限管理」发起/授予，未开通会导致对应接口报错）：

| 权限代码 | 权限名 | 用途 |
|---|---|---|
| `qyapi_get_department_member` | 通讯录部门成员读权限 | 拉取部门内成员 userId/name（构建通讯录选择器） |
| `qyapi_get_department_list` | 通讯录部门信息读权限 | 拉取部门列表（构建部门树） |

相关 OpenAPI（oapi，用企业 accessToken 调用）：
- `POST /topapi/v2/department/listsub` 查下一级部门
- `POST /topapi/user/listsimple` 查部门内成员

> 注意：审批/发成员选择器依赖以上两个权限；若只需 webhook 群机器人发卡可忽略。`openConversationId` 钉钉没有"列出全部群"接口，需在创建场景群时保存。

---

## 执行器接入点（两种方式共用）

`backend/index.js` 以 `createEciProvider({ create: createEciGroup })` 注入派发函数；`createEciGroup` 是**当前唯一的真实接入点位**，应实现阿里云 `CreateContainerGroup` OpenAPI：

- 用节点 `params.image` / `params.command` / `env` / `resource` / `timeout`；
- 给容器注入环境：`IMAGE`、`COMMAND`、`CLOUDSHUTTLE_JOB_URL`、`CLOUDSHUTTLE_TOKEN`、`CLOUDSHUTTLE_EXEC_ID`、`CLOUDSHUTTLE_NODE_ID`、`CLOUDSHUTTLE_CB_BASE`（与 `runner/run.sh` 读取对应）；
- 容器退出后回调 `/_/hook/ecidone/{execId}`（成功）或 `/_/hook/fail/{execId}`（失败）；回调 URL 由控制面生成，
  鉴权双因子走 query：`?token=<回调token>&secret=<回调密钥>`（与 `webhook_registry` 登记记录比对，且 `/_/` 仅内网可访问）。

本地单测以 mock `create` 注入，不依赖真实云资源，因此不接入也可跑通单测。

---

## 端到端验收（demo-rollout）

### webhook 触发地址与管理端点

触发地址**由后端生成**（管道名做百分号编码，中文/空格名都可用；后端消费时解码还原），在流水线编辑页直接复制即可：

```bash
# {管道名} 为百分号编码后的 name，secret 为该管道独立密钥
curl -X POST 'http://localhost:9000/hook/webhook/demo-rollout?secret=<你的密钥>' \
  -H 'content-type: application/json' -d '{"ref":"refs/heads/main"}'
```

**能力边界（务必按此对接第三方）**：

- 请求体只支持 `Content-Type: application/json`；平台把 body 原样存入执行留痕，并按节点配置的 JSONPath 映射成变量；
- 鉴权只支持 **URL query 携带 `?secret=`**，**不支持签名头 / HMAC 校验**（GitHub 的 `X-Hub-Signature-256` 之类一律不校验）；密钥按管道独立、创建时生成；
- 返回码：`200` 触发成功、`401` 密钥不匹配、`503` 该管道密钥未配置、`404` 路由不存在、`500` 处理抛错；
- **改名会使触发地址变化**（地址里带的是管道名），改名后需重新复制地址给第三方。

| 管理端点 | 方法 | 用途与返回 |
|---|---|---|
| `/api/pipelines/:id/webhook-secret` | GET | 取该管道的密钥与完整触发地址 `{ ok, id, name, secret, url }`；密钥为空时懒生成。密钥**只能**经此接口与下面的 reset 显式获取，常规的管道 list/get/create/update 返显不含 `webhook_secret` |
| `/api/pipelines/:id/webhook-secret/reset` | POST | 轮换密钥（泄露/定期换），返回新的 `{ ok, id, name, secret, url }`；拿到新地址后需到第三方同步更新 |
| `/api/pipelines/:id/webhook-probe` | GET | 调试探针：该管道**最近一次**投递的 `{ ok, body, receivedAt, httpStatus }`。`body` 为第三方真实请求体（序列化超 256KB 时只存前 100KB 预览 `{"_truncated":true,"preview":"…"}`）；`httpStatus` 是那次投递的处理结果（200/401/503/500，`null`=尚无记录）。密钥错的投递也会记录，故 401 时仍能看到 body |

期望流转：`running → (shell→ECI) → 发审批卡片 → (通过) → succeeded`。
跑之前：确认已创建名为 `demo-robot` 的钉钉机器人凭证（approval 节点 `params.robot` 引用它）。