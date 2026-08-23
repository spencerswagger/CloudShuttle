# 部署手册

本平台只有**两种**部署方式：

| 方式 | 控制面 | 数据库 / Redis | 执行器(ECI) | 适用 |
|---|---|---|---|---|
| **A. docker compose（本机）** | 本地容器（可加载 release 镜像） | 本地容器（也可换云） | 阿里云 | 开发 / 演示 |
| **B. 云端部署（纯阿里云）** | SAE（推荐）/ FC | 云 RDS / 云 Redis | 阿里云 | 生产 |

> 无论哪种方式，**执行器（ECI）始终走阿里云**——它是按需拉起的容器，本机起不来。

---

## 0. 获取发布产物（无需自行打包）

到 **GitHub Release**（<https://github.com/spencerswagger/CloudShuttle/releases>）按 tag（如 `v0.1.0`）下载两个资产：

| 资产 | 内容 | 用在哪 |
|---|---|---|
| `cloudshuttle-backend-<tag>.tar` | 控制面后端镜像（docker tar） | 方式 A：`docker load`；方式 B：SAE 镜像部署 |
| `cloudshuttle-web-<tag>.zip` | 前端静态包 | 方式 B：上传 OSS/CDN |

这些资产由 GitHub Action 在打 tag 时自动产出。若要**自己打包源码**（本地开发 / FC 代码包 / 改镜像），见各子 README：

- **后端（控制面）打包** → [backend/README.md](../backend/README.md)（含 SAE 镜像、FC 代码包两种打包）
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
| 云数据库 RDS PostgreSQL | 定义/执行历史 | 记下连接串 |
| 云数据库 Redis | 状态快照/锁 | 记下连接串 |
| SAE 2.0（Web 应用） | 控制面（推荐） | 控制台 `saenext.console.aliyun.com`（旧 `sae.console` 已下线）；镜像部署，**Web 应用 + 按需分配 CPU** 才可缩容到 0、无请求不分配 CPU |
| FC（函数计算） | 控制面（可选替代 SAE） | Node18+ 函数，HTTP 触发，代码包部署 |
| OSS + CDN | 托管前端 | 静态桶，接 CDN |
| 容器镜像 ACR | 控制面镜像 + 执行器镜像 | backend tar 与 runner 镜像推送位 |
| 云容器 / ECI 权限 | 拉执行容器 | 见"执行器接入点" |

### B.2 控制面：SAE 还是 FC（同一份代码）

后端是**一份代码、两种入口**，选哪个阿里云产品承接它：

| 维度 | SAE 2.0（Web 应用，推荐） | FC（函数计算） |
|---|---|---|
| 用什么跑 | 监听 HTTP 的进程（`local-server.js`） | `index.js` 的 `handler`（代码包）；或 `local-server.js`（自定义容器镜像） |
| 部署物 | **release 的后端 tar**（`docker load` → 推 ACR → 镜像部署） | 代码包见 backend/README；或直接推 release 后端镜像做**自定义容器**（需 `SKIP_BOOTSTRAP=1`） |
| 计费 | 缩容到 0 + 无请求不分配 CPU + 无小时保底 | 有「小时最低消费」：偶发调用也有空转费 |
| 健康检查 | `GET /healthz`（已内置，供 liveness/readiness） | 容器探活/函数健康检查；镜像路径 `/healthz` |
| 权衡 | 低流量更省；研究结论见 `docs/research/sae-vs-fc.md` | 同上 |

**走 SAE（用 release tar）：**
```bash
docker load -i cloudshuttle-backend-<tag>.tar
docker tag cloudshuttle-backend:<tag> registry.cn-hangzhou.aliyuncs.com/<ns>/cloudshuttle-backend:<tag>
docker push registry.cn-hangzhou.aliyuncs.com/<ns>/cloudshuttle-backend:<tag>
```

在 **`saenext.console.aliyun.com`**（旧 `sae.console` 已下线）建 **Web 应用**（镜像部署）：

- **应用类型**必须选 **`Web 应用`**（不是 `微服务应用`）——只有 Web 应用支持缩容到 0；
- **CPU 分配模式**选 **`按需分配 CPU`（请求到来才分配）**——这是缩容到 0 的前提；Web 应用若选「固定分配 CPU」、或建微服务应用，都**没有**缩容到 0；
- 容器端口 `9000`，健康检查路径 `/healthz`；绑自定义域名并写入 `CONTROL_BASE`；环境变量照 B.3；
- 计费：Web 应用按需 CPU 模式按 **请求数 + 公网出流量 + 实际占用 CPU/内存** 计费，空闲不分配 CPU 故无空转费；
- 冷启动：缩容到 0 后靠冷启动拉起（本项目 Node 控制面冷启动较快，比 Java 友好）；想加快可设 `SKIP_BOOTSTRAP=1`（跳过建表/seed），改由部署时手动执行一次：
  `node backend/db/migrate.js` + `psql -f deploy/seed.sql`。

**走 FC（自定义容器 · 完整步骤）：**

> 用**镜像**在 FC 上跑控制面时，走「自定义容器/WEB 服务」模式，运行的是 `local-server.js`（:9000）。镜像的 `entrypoint.sh` 默认会 `waiting for postgres...` 等到 PG 就绪才起服务——**必须配 `SKIP_BOOTSTRAP=1`** 跳过它，否则服务起不来、探活超时被回收（日志表现：`Function instance health check failed on port 9000`）。最重要的是，**PG/Redis 必须真正配到 FC 能连通**。

1. **建函数（自定义容器）**
   - 镜像：选 ACR 里的 `<ns>/cloudshuttle-backend:<tag>`
   - 监听端口：`9000`；健康检查路径：`/healthz`

2. **网络（最易漏，决定 `waiting for postgres` 是否卡死）**
   - FC 的 **VPC 配置**选与 RDS **相同**的 VPC、交换机、安全组；`PG_HOST` 用 RDS **内网**域名
   - **RDS 白名单**加入该交换机网段 / FC 安全组
   - Redis 同 VPC 或公网版，`REDIS_URL` 必须 FC 可达（否则 API 用到状态快照时再报错）

3. **环境变量（逐项填；值见 B.3）**

   | 变量 | 必填 | 说明 |
   |---|---|---|
   | `SKIP_BOOTSTRAP=1` | ✅ | 跳过等 PG + migrate/seed，服务立即起、探活秒过 |
   | `PORT=9000` | ✅ | 与容器监听端口一致 |
   | `PG_HOST` / `PG_PORT` / `PG_DB` / `PG_USER` / `PG_PASSWORD` | ✅ | 填 RDS 内网地址；**漏了必卡 `waiting for postgres`** |
   | `REDIS_URL` | ✅ | FC 可达的 Redis |
   | `CONTROL_BASE` | ⭕ | FC 自定义域名；漏了回调拼接可能错 |
   | `SM4_KEY` | ⭕ | 用凭证库才填 |

4. **首次迁移/seed**（因 `SKIP_BOOTSTRAP=1` 已跳过，只手动执行一次）：
   ```bash
   node backend/db/migrate.js
   psql "$PG_URL" -f deploy/seed.sql
   ```

5. **绑自定义域名**并写入 `CONTROL_BASE`（默认函数 URL 会随冷启动变化）。

**FC 走函数代码包（备选）**：见 [backend/README.md](../backend/README.md)，上传 `cloudshuttle-fc-<tag>.zip`，建 Node18+ HTTP 触发函数，入口 `index.js` 的 `handler`，同样要配 B.3 的 PG/REDIS 环境变量与 VPC 网络。

### B.3 环境变量（全局填这些）

`backend/config.js` 读取，完整作用见 `deploy/env.example`：

| 变量 | 必填 | 示例 | 说明 |
|---|---|---|---|
| `PG_HOST` / `PG_PORT` / `PG_DB` / `PG_USER` / `PG_PASSWORD` | ✅ | `xxx.pg.rds.aliyuncs.com` / `5432` … | 云 RDS PostgreSQL |
| `REDIS_URL` | ✅ | `rediss://:pwd@xxx.redis.rds.aliyuncs.com:6379` | 云 Redis |
| `CONTROL_BASE` | ⭕ | `https://cloudshuttle.example.com` | 控制面自定义域名；填了最稳，不填则自动推导 |
| `SM4_KEY` | ⭕ | 32 位 hex | 用凭证库时**必须**填；改 KEY 会令历史凭证解不开 |
| `ALIYUN_AK` / `ALIYUN_SK` / `ALIYUN_REGION` | ① | … | ECI 派发用（也可用 FC Role 授权替代） |

> ① ECI 相关：正式跑 shell 前必须配好。数据库迁移与 seed 可手动执行一次：
> `node backend/db/migrate.js` + `psql "$PG_URL" -f deploy/seed.sql`（compose 已自动处理，云端需手动跑一次）。

### B.4 前端 → CDN（用 release 的 web zip）

```bash
unzip cloudshuttle-web-<tag>.zip -d cloudshuttle-web    # 解压即 `dist/` 内容
```

- **部署物**：把解压出的**整个目录**上传到这个静态 OSS 桶，开启**静态网站托管**，接 CDN；
- 入口文件就是 `index.html`；
- 前端调用后端用的是相对路径 `/api/*` 等，因此需要一个**网关/CDN 规则**把这些路径**反向代理**到控制面自定义域名：
  ```
  /api/*、/hook/*、/_/hook/*  →  反代到 https://你的控制面域名
  ```
- （自建打包见 [frontend/README.md](../frontend/README.md)）

### B.5 执行器镜像（runner → ACR → ECI）

完整构建与推送见 [runner/README.md](../runner/README.md)，要点：

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