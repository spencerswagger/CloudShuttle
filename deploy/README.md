# 部署手册

本平台只有**两种**部署方式：

| 方式 | 控制面 | 数据库 / Redis | 执行器(ECI) | 适用 |
|---|---|---|---|---|
| **A. docker compose（本机）** | 本地容器 | 本地容器（也可换云） | 阿里云 | 开发 / 演示 |
| **B. 云端部署（纯阿里云）** | FC 函数 | 云 RDS / 云 Redis | 阿里云 | 生产 |

> 无论哪种方式，**执行器（ECI）始终走阿里云**——它是按需拉起的容器，本机起不来。

整体产物（部署的"东西"也只有这三样）：

| 产物 | 来源 | 部署到 |
|---|---|---|
| 控制面（后端 API + 状态机） | `backend/` | FC 函数（HTTP 触发） |
| 执行器（跑 shell 的容器） | `runner/` → 构建镜像 | 阿里云 ACR → ECI |
| 前端（Web 画布） | `frontend/dist/`（静态文件） | CDN / OSS |

---

## 方式 A：docker compose（本机）

只需 Docker，一条命令起全部；ECI 仍用阿里云。

```bash
# 1. 可选：覆盖环境变量（不建也能用默认值启动）
cp deploy/env.example .env

# 2. 构建并启动（首次自动 build 前端 + 后端，并迁移/seed）
docker compose up -d --build

# 3. 访问
#    前端画布  http://localhost:8080
#    控制面API http://localhost:9000/api/pipelines
#    状态/日志 docker compose ps | logs -f backend
```

**这个 compose 帮你起了什么**（根目录 `docker-compose.yml`）：
- `postgres`（本地 PG，数据卷持久化）
- `redis`（本地 Redis）
- `backend`（控制面容器：启动时自动 **建表迁移 + 灌 seed**，监听 9000）
- `frontend`（nginx：托管前端静态页，并把 `/api` `/hook` `/_/hook` 反代到 backend）

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
| 云数据库 RDS PostgreSQL | 定义/执行历史 | 记下连接串 |
| 云数据库 Redis | 状态快照/锁 | 记下连接串 |
| FC（函数计算） | 控制面 | 建一个 Node18+ 函数，HTTP 触发 |
| SAE（Serverless 应用引擎） | 控制面（可选替代 FC） | 2.0 **Web 应用**，镜像部署，可缩容到 0、无小时保底；低流量更省 |
| OSS + CDN | 托管前端 | 静态桶 |
| 容器镜像 ACR | 执行器镜像 | runner 镜像推送位 |
| 云容器 / ECI 权限 | 拉执行容器 | 见"执行器接入点" |

### B.2 控制面：FC 还是 SAE（同一份代码）

后端是**一份代码、两种入口**，根据你想用哪个阿里云产品承接它：

| 维度 | FC（函数计算） | SAE 2.0（Web 应用） |
|---|---|---|
| 用什么跑 | `backend/index.js` 的 `handler(event)`（FC 事件函数） | 监听 HTTP 的进程（`backend/local-server.js`） |
| 部署物 | 打包 `backend/` 为函数代码包 | **同一个镜像**（`backend/Dockerfile`，推 ACR 镜像部署） |
| 计费 | 有「小时最低消费」：偶发调用也有空转费 | 缩容到 0 + 无请求不分配 CPU + 无小时保底；低流量更省 |
| 自定义域名 | 绑到函数 | 绑到 SAE 应用 |
| 健康检查 | — | `GET /healthz`（已内置，供 liveness/readiness） |
| 权衡 | 研究结论见 `docs/research/sae-vs-fc.md` | 同上 |

**走 FC：**
- 部署物：整个 `backend/` 文件夹打包；
- 入口：`backend/index.js` 导出的 `handler`（FC 以 `{path,httpMethod,body,headers}` 传入）；
- 运行时：Node.js 18+（`package.json` engines ≥18）；触发器 HTTP；
- 绑**自定义域名**（函数 URL 会随冷启动变化），把域名填进 `CONTROL_BASE`；环境变量照 B.3。

**走 SAE：**
- 构建镜像：`docker build -f backend/Dockerfile -t <ACR>/cloudshuttle-control:0.1 . && docker push ...`
- 在 SAE 建 **Web 应用**（镜像部署）：容器端口 `9000`，健康检查路径 `/healthz`，绑自定义域名并写入 `CONTROL_BASE`；
- 想加快冷启动可设 `SKIP_BOOTSTRAP=1`（跳过建表/种子），改由部署时手动执行一次：`node backend/db/migrate.js` + `psql -f deploy/seed.sql`；默认（不设）也会自动迁移+seed（幂等）；
- 环境变量照 B.3。

### B.3 环境变量（全局填这些）

`backend/config.js` 读取，作用见 `deploy/env.example`：

| 变量 | 必填 | 示例 | 说明 |
|---|---|---|---|
| `PG_HOST` / `PG_PORT` / `PG_DB` / `PG_USER` / `PG_PASSWORD` | ✅ | `xxx.pg.rds.aliyuncs.com` / `5432` … | 云 RDS PostgreSQL |
| `REDIS_URL` | ✅ | `rediss://:pwd@xxx.redis.rds.aliyuncs.com:6379` | 云 Redis |
| `CONTROL_BASE` | ⭕ | `https://cloudshuttle.example.com` | FC 自定义域名；填了最稳，不填则自动推导 |
| `SM4_KEY` | ⭕ | 32 位 hex | 用凭证库时**必须**填；改 KEY 会令历史凭证解不开 |
| `ALIYUN_AK` / `ALIYUN_SK` / `ALIYUN_REGION` | ① | … | ECI 派发用（也可用 FC Role 授权替代） |

> ① ECI 相关：正式跑 shell 前必须配好。数据库迁移与 seed 可手动执行一次：
> `node backend/db/migrate.js` + `psql "$PG_URL" -f deploy/seed.sql`（compose 已自动处理，云端需手动跑一次）。

### B.4 前端 → CDN（部署 `frontend/dist/`）

```bash
cd frontend && npm install && npm run build   # 产物在 frontend/dist/
```

- **部署物**：把 `frontend/dist/` **整个目录**上传到 OSS，开启**静态网站托管**，接 CDN；
- 入口文件就是 `dist/index.html`；
- 前端调用后端用的是相对路径 `/api/*` 等，因此需要一个**网关/CDN 规则**把这些路径**反向代理**到 FC 自定义域名：
  ```
  /api/*、/hook/*、/_/hook/*  →  反代到 https://你的FC自定义域名
  ```

### B.5 执行器镜像（runner → ACR → ECI）

```bash
docker build -t registry.cn-hangzhou.aliyuncs.com/<ns>/cloudshuttle-runner:0.1 runner/
docker push registry.cn-hangzhou.aliyuncs.com/<ns>/cloudshuttle-runner:0.1
# 并把 seed 里 "Docker+Git 构建" 镜像改指向 ACR 地址（默认 cloudshuttle/runner:0.1）
```

### B.6 审批机器人（可选）

审批卡点用**钉钉群机器人**发送。先在 Web 画布的"凭证"页创建 `dingtalk-robot` 凭证（webhook 地址 + 可选加签密钥），再把凭证名填进管道 approval 节点的 `params.robot`。无需任何平台级环境变量。

---

## 执行器接入点（两种方式共用）

`backend/index.js` 以 `createEciProvider({ create: createEciGroup })` 注入派发函数；`createEciGroup` 是**当前唯一的真实接入点位**，应实现阿里云 `CreateContainerGroup` OpenAPI：

- 用节点 `params.image` / `params.command` / `env` / `resource` / `timeout`；
- 给容器注入环境：`IMAGE`、`COMMAND`、`CLOUDSHUTTLE_JOB_URL`、`CLOUDSHUTTLE_TOKEN`、`CLOUDSHUTTLE_EXEC_ID`、`CLOUDSHUTTLE_NODE_ID`、`CLOUDSHUTTLE_CB_BASE`（与 `runner/run.sh` 读取对应）；
- 容器退出后回调 `/_/hook/ecidone/{execId}`（成功）或 `/_/hook/fail/{execId}`（失败）。

本地单测以 mock `create` 注入，不依赖真实云资源，因此不接入也可跑通单测。

---

## 端到端验收（demo-rollout）

POST 一个 git webhook：
```bash
curl -X POST http://localhost:9000/hook/git/demo-rollout \
  -H 'content-type: application/json' -d '{"ref":"refs/heads/main"}'
```
期望流转：`running → (shell→ECI) → 发审批卡片 → (通过) → succeeded`。
跑之前：确认已创建名为 `demo-robot` 的钉钉机器人凭证（approval 节点 `params.robot` 引用它）。