# 选型备忘：控制面从 FC 迁到 SAE？

> 状态：**仅研究记录，未落地、未改代码**。后续决定迁移时机再据此执行。
> 研究时间：2026-08
> 背景：用户反馈 FC 引入「小时级最低消费」，对低流量 CI/CD 控制面造成空转浪费，需评估 SAE 是否能胜任。

---

## 1. 结论（TL;DR）

- **控制面**：SAE 2.0 **Web 应用**可胜任（支持缩容到 0、仅在请求时分配 CPU、自定义域名、健康检查、按秒计费），且**无** FC 小时保底 → 对「低流量、可缩 0」负载更省、更可控。
- **执行器**：维持 **ECI 按需容器**即可；SAE **Job**（HTTP 触发一次性任务）可作为统一托管的可选项，但非必需。
- **前端**：不变，仍走 CDN。
- 决策：当前**仅记录**，控制面不迁移、执行器不迁移。

---

## 2. 为什么想迁：FC 的新计费痛点

FC 自 2026-03-30 灰度「小时级最低消费」：单小时内只要有调用或占用计算资源，即便实际只跑几十 ms，该小时也保底计 **0.01 元**；超过则按实际结算。对 CI/CD 控制面（每天在散落的多个小时被 git webhook/回调唤醒），每月空转约 30 元，且随触发分布线性累积。

参考：
- FC 计费说明：[$TRAE_REF](https://help.aliyun.com/zh/functioncompute/billing-fc/)
- 关于优化函数计费模式的说明（小时保底）：[$TRAE_REF](https://help.aliyun.com/zh/functioncompute/fc/product-overview/product-change-description-on-optimizing-function-billing-mode)

---

## 3. SAE 能力评估（对照本平台的三个使用点）

| 使用点 | 推荐 SAE 形态 | 是否胜任 | 关键结论 |
|---|---|---|---|
| 控制面 HTTP 服务 | **Web 应用** | ✅ | 仅请求时分配 CPU、可缩容到 0、自定义域名、健康检查；微服务应用**不支持**缩容到 0 |
| 执行器（一次性 shell） | **Job 任务**（或维持 ECI） | ✅ / 可选 | Job 支持 HTTP 触发、任务完成释放资源、按实际运行时长计费 |
| 前端 | —（CDN） | 不变 | 不涉及 SAE |

- 缩容到 0 仅 Web 场景支持，微服务不支持（冷启动延迟差异）：[$TRAE_REF](https://help.aliyun.com/en/sae/does-sae-2-0-all-applications-support-shrinking-to-0)
- SAE 2.0 商用与计费项变更：[$TRAE_REF](https://help.aliyun.com/en/sae/product-overview/product-change-sae-2-0-commercial-and-sae-billing-item-change-notice)
- 镜像部署（支持 Node/任意语言）：[$TRAE_REF](https://help.aliyun.com/zh/sae/use-images-to-deploy-applications-in-the-sae-console)
- SAE Job 任务模板：[$TRAE_REF](https://help.aliyun.com/zh/sae/job-template-management-2-0)
- SAE 产品计费总览：[$TRAE_REF](https://help.aliyun.com/zh/sae/product-overview/billing-new)

---

## 4. 计费对比（核心差异）

| 维度 | FC | SAE 2.0 · Web 应用 |
|---|---|---|
| 无请求/空载 | 缩到 0；但有调用的小时收 **0.01 元保底** | **缩到 0 + 无请求不分配 CPU，无小时保底** |
| 计费项 | CU（vCPU/内存/磁盘/调用次数）+ 小时保底 | vCPU 使用量、内存、请求数、流量，秒级 |
| 对偶发负载 | 逐小时空转累积 | 无请求时段 = 0 vCPU 费用 |
| 一次性任务 | —（函数） | Job 按实际运行时长×规格计费 |

Web 应用计费总览：[$TRAE_REF](https://help.aliyun.com/en/sae/billing-overview-web-applications)

---

## 5. 迁移方案（若未来执行）

**控制面（backend/ → SAE Web）**
- 后端是 FC event 风格 `handler({path,httpMethod,body})`。SAE Web 要跑一个**监听 HTTP 端口的容器**；
- 现成的 `backend/local-server.js` 已把 HTTP 请求组装成 event 再调 `handler` → **把 `backend/` 打成 Docker 镜像、SAE 镜像部署即可，后端逻辑基本不用改**；
- 环境变量照填（PG_* / REDIS_URL / CONTROL_BASE / SM4_KEY / ALIYUN_*），`CONTROL_BASE` 填 SAE 自定义域名；
- 绑定自定义域名 + 健康检查。

**执行器**
- 维持 ECI（已接入方案）；或后续改为 SAE Job 派发（替换 `createEciGroup` 逻辑）。

**前端**：`frontend/dist/` → CDN，网关反代 `/api`、`/hook`、`/_/hook` 到 SAE 域名。

---

## 6. 迁移前待验证项（风险点）

- [ ] SAE Web 缩到 0 后**首次请求的冷启动唤醒**是否可接受（官方未明示与 FC 完全一致的请求秒唤醒）；
- [ ] 接入公网是否需要 **CLB/SLB** 兜底（独立计费，删除应用后可能仍计费）；
- [ ] **配套成本**：VPC / 日志 SLS 等是否拉高总账单；
- [ ] 是否需要购买 **CU 资源包**还是按量付费更优。

风险与配套成本参考：[$TRAE_REF](https://help.aliyun.com/zh/sae/product-overview/billing-new)

---

## 7. 决策记录

- 2026-08：确认 FC 小时保底存在 → SAE Web 更省更可控；
- 决定：**控制面不迁移、执行器不迁移**（仅研究记录）；
- 触发迁移的条件：实际账单显示 FC 空转费用不可接受，或上线后需要更可控的冷启动/资源策略。