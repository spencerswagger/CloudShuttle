# backend · 控制面

Node 编排引擎与控制面，单份代码支持 **FC handler** 与 **SAE/本地 HTTP 容器** 双入口。

## 职责

- 处理 `/api/*`（管道定义 / 执行历史 / 凭证 / 预置镜像）、`/hook/*`（git / 钉钉外部回调）、`/_/hook/*`（ECI 完成内部回调）；
- DAG 状态机：**一次推进续跑**，每次被触发都是一次短且无状态的推进，推进完释放实例、缩容到 0；
- 下发 ECI 一次性执行容器、登记审批卡点并支持断点续跑；
- 凭证 SM4 加密存储（`sm-crypto`）。

## 目录

```
backend/
  index.js            # FC handler 入口（event → routeToHandler）
  local-server.js     # HTTP 入口（监听 :9000，含 /healthz），供 SAE / 本地容器
  config.js           # 环境变量读取（PG/Redis/SM4_KEY/CONTROL_BASE/ALIYUN_*）
  db/                 # schema.sql / migrate.js / seed.sql、pg.js、redis.js
  engine/             # dag.js 拓扑、state.js、snapshot.js、mutex.js、orchestrator.js
  steps/              # shell.js（→ECI 派发）、approval.js（钉钉卡点）
  providers/          # eci.js、dingtalk.js
  handlers/           # api.js、hook.js、internal.js
  crypto/             # sm4.js
  test/               # node --test 单测
```

## 本地运行

```bash
npm install
# 需本地 PG(库/账号 cloudshuttle) 与 Redis；见根目录 deploy/README.md 的 docker compose
node db/migrate.js            # 建表
node local-server.js          # 监听 http://localhost:9000
```

## 环境变量

必填/可选详见 [deploy/README.md](../deploy/README.md) 的变量表，核心：`PG_*`、`REDIS_URL`、`SM4_KEY`、`CONTROL_BASE`、`ALIYUN_*`。

## 测试

```bash
npm test   # node --test，PG 相关用例在无库环境自动跳过
```

参考：整体设计见 [docs/superpowers/specs](../docs/superpowers/specs/2026-08-20-serverless-jenkins-design.md)。