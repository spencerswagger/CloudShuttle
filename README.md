# CloudShuttle · 云梭

**云原生的 Serverless 流水线编排平台** —— 一个"无服务器版 Jenkins"，交互形态上又类似 n8n：用可视化画布把 `shell` 执行节点和 `approval` 审批节点拼成 DAG 工作流，但**全部托管在云厂商 Serverless 能力之上，闲时缩容到 0、调用时按需拉起**，最大化节省云资源开销。

## 背景与动机

传统 CI/CD（Jenkins / 自建 Runner）需要常驻实例，即使空闲也在空烧资源。云厂商的**函数计算 / 弹性容器**支持"无调用时实例为 0、来请求才拉起"，天然契合低频但重要的流水线场景——只在有 webhook 或审批回调时才跑，其余时间零占用。

由此也带来三处架构约束：

1. **服务必须快速启动**（冷启动即接请求）；
2. **触发源基本只能 HTTP 调用**（webhook / 审批回调 / ECI 完成回调）；
3. **控制面语言收敛到 Node**（`handler` 无状态纯函数 + 通用镜像双载体运行）。

## 核心能力

- **触发**：git push / tag 等通用 HTTP webhook 触发流水线；
- **编排**：DAG 画布可视化拼节点，异步回调续跑（执行器/审批完成 → 冷启动新实例 → 断点续跑）；
- **节点**：`shell`（拉代码 / 构建 / 推镜像 / kubectl 升级，跑在弹性容器里）+ `approval`（钉钉群机器人卡片审批卡点）；
- **凭证库**：SM4 加密存储（git / docker registry / 对象存储 / 钉钉机器人等），避免凭证明文入库；
- **预置镜像后台**：常用语言环境的 runner 镜像预置，可后台增删。

## 架构总览

```
CDN（前端静态，0 成本 >  Vue3 画布）
        │ REST /api/*、/hook/*、/_/hook/*
        ▼
控制面（Node；FC Web 函数 handler 或 SAE Web 镜像，可缩 0）
        │ 下发一次性任务 / 收回调
        ▼
执行器（阿里云 ECI 弹性容器，按秒计费、跑完即销毁）
        │
Redis(状态快照/锁) · PostgreSQL(定义/执行历史)   ←  环境托管
```

> 完整设计文档（节点模型、hook 路由约定、执行状态机、数据模型、接口清单）：[specs](./docs/superpowers/specs/2026-08-20-serverless-jenkins-design.md)
>
> 实施计划与任务拆分：[plans](./docs/superpowers/plans/2026-08-20-serverless-jenkins.md)
>
> 控制面载体选型（FC vs SAE 计费对比结论）：[research](./docs/research/sae-vs-fc.md)

## 目录结构与文档导航

| 目录 | 说明 | 文档 |
|---|---|---|
| `backend/` | 控制面：Node 编排引擎、DB/Redis 层、SM4 加密、hook 路由、FC handler + local HTTP 双入口 | [backend/README.md](./backend/README.md) |
| `frontend/` | Vue3 管理端：画布 / 凭证 / 镜像 / 执行页 | [frontend/README.md](./frontend/README.md) |
| `runner/` | 执行器镜像：在 ECI 容器内跑 `git clone → build → push → kubectl` | [runner/README.md](./runner/README.md) |
| `deploy/` | 部署：docker compose（本机）与纯阿里云托管（FC/SAE + CDN + ECI） | [deploy/README.md](./deploy/README.md) |
| `docs/` | 设计 / 计划 / 选型备忘 | 见上方链接 |

## 快速开始

本机一键体验（需要已装 Docker）：

```bash
docker compose up -d --build
# 管理端  http://localhost:8080
# 后端 API http://localhost:9000/api/pipelines
```

对接阿里云（ECI / FC / SAE / CDN）的完整步骤见 [deploy/README.md](./deploy/README.md)。

## License

[MIT](./LICENSE)