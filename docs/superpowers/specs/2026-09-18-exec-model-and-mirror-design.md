# Shell 执行模型与镜像供给 定稿设计

日期：2026-09-18
状态：待审核（用户要求先出设计文档，此版为按反馈重写后的定稿稿）

## 背景与问题

v0.3.0-rc3 执行契约（命令内联 + curl 回调）实测暴露：

1. **镜像工具依赖脆弱**：`node:20-slim` / `python:3.12-slim` 等小镜像不自带 curl（slim 系连
   wget 也没有），Pod 报 `sh: 11: curl: not found`；而完整版 `node:20` 体积 ~1.7GB（解压）过大。
2. **无现成"小 + 语言 + git + curl + docker 客户端"一体镜像**：官方镜像要么大（完整版，自带
   git/工具链）要么缺（slim/alpine 只有一个运行时）。
3. **跨节点无工作区共享**：真实 CI（git clone → build → docker build）拆节点时无文件共享。

与用户多轮讨论后拍板（详见下节）：**不引入工作区共享/不入 pull 回调**；把「镜像怎么办」交回
镜像供给侧解决——在本仓库用 GitHub Action 手动触发，把一批常用镜像同步推送到私有镜像仓库
（阿里云 ACR），供集群直接拉取（快、稳、统一地址）。

## 已确认决策（2026-09-18 用户拍板）

1. **不做工作区共享**：shell 节点间不共享文件系统；多步骤（clone + build + docker build）由
   用户写在**单个节点**命令里串联（`&&`）；跨节点仍用 K=V 变量（`${name}`）。不使用 PV/PVC，
   不做对象存储产物中转。
2. **回调链路不改**：保持现有「容器内 curl 回调 `/_/hook/ecidone|fail`」契约；不引入控制面
   主动拉取（pull）方案。「镜像须自带 curl」由镜像供给解决，缺工具时节点报错行为见「执行契约现状」。
3. **镜像供给 = 仓库内 GitHub Action 手动构建/同步**：在 CloudShuttle 仓库新增
   `workflow_dispatch` 触发的 workflow，复用
   [spencerswagger/private-docker-mirror](https://github.com/spencerswagger/private-docker-mirror)
   的 skopeo 登录 + 批量同步模式，把常用 CI/语言镜像同步推送到私有 ACR；
   `exec_image` 种子与前端默认镜像切到 ACR 地址。
4. 项目未 release，**不做兼容**。

## 镜像供给设计

### 4.1 workflow：`.github/workflows/sync-ci-images.yml`

参照 `private-docker-mirror/.github/workflows/sync-manual.yml`：

- `workflow_dispatch` 手动触发，输入 `image`（默认 `ci-images.txt` 清单，可单条覆盖）；
- 步骤：checkout → 安装静态 `skopeo` → 用 secrets `DOCKER_USERNAME/DOCKER_PASSWORD`
  登录 ACR（`registry.cn-hangzhou.aliyuncs.com`）→ 按清单逐条 `skopeo copy` 从
  docker.io 同步到 ACR（标签保留 latest/major，跳过 rc/beta/dev，参照 `sync_only_popular_tags`）；
- 复用/精简 `image.txt` + `sync.sh` 逻辑（本仓库内置 `ci-images.txt`，不依赖外部 repo）。

### 4.2 初始镜像清单（`ci-images.txt`，体积与工具标注）

| 镜像（docker.io 源） | 解压体积参考 | curl | git | 用途建议 |
|---|---|---|---|---|
| `node:20-alpine` | ~190 MB | ✗（busybox wget） | ✗ | 前端/Node 构建；命令内 `apk add --no-cache curl git` |
| `node:20` | ~1.7 GB | ✓ | ✓ | 需要完整工具链的 Node 构建（体积大，按需同步） |
| `python:3.12-alpine` | ~80 MB | ✗ | ✗ | Python 构建；同上 `apk add` |
| `golang:1.23-alpine` | ~250 MB | ✗ | ✗ | Go 构建；同上 |
| `golang:1.23` | ~800 MB | ✓ | ✓ | 需系统工具链的 Go 构建（按需） |
| `docker:24-cli` | ~50 MB | ✓ | ✗ | 提供 docker 客户端（镜像内 build 依赖宿主/外部 daemon，见 4.3） |
| `alpine:3.20` | ~7 MB | ✗（wget） | ✗ | 通用脚本类任务最小值，`apk add curl git` |

> 汇总核对：官方语言镜像只有**非 slim/alpine 的完整版**自带 curl+git；小体积方案一律走
> `apk add --no-cache curl git`（约 +8MB，一条命令）。清单默认只同步 alpine 系 + `docker:cli`，
> 完整版列在注释里按需取消注释。

### 4.3 docker build 的约束（文档明示）

k8s Job 容器内**没有 docker daemon**：`docker build` 需特权/DinD（平台不开放），标准替代是
kaniko（免 daemon 静态二进制）或连外部 daemon。本轮镜像只负责提供 **docker 客户端**
（`docker:cli` / `apk add docker-cli`），实际 build 的 daemon 选型作为命令模板说明留给用户
（示例命令里放 kaniko 用法），平台不承担 daemon 编排。

### 4.4 seed 与前端默认镜像切换

- `deploy/seed.sql` 的 `exec_image` 预置改为 ACR 地址：`registry.cn-hangzhou.aliyuncs.com/<ns>/<repo>:<tag>`；
- 即使 ACR 尚未同步，种子保留 docker.io 原地址兜底（镜像不存在不影响建表，节点选择时提示）。

## 执行契约现状（本次不改动，仅补齐文案）

- 命令内联、附加凭证 Secret（subPath/secretKeyRef）、资源规格 requests==limits、
  日志 3MB 上限 + 截断标记、`CALLBACK_BASE_INTERNAL` 内网回调前缀 均保持现状。
- **缺 curl 的行为**（保持现状并文档化）：wrapper 未探测工具，容器内 `curl: not found`
  会导致无法回调、节点停留在等待直至 registry 过期——因此镜像清单与节点表单都提示
  「镜像需自带 curl」；选用未含 curl 的镜像属配置错误，由用户按 4.2 表选择/自装。

## 前端改动

- 镜像选择下拉 hint 更新：提示 ACR 私有源 + 小镜像需 `apk add curl git`；
- 表单「运行镜像」占位文案示例补充 `apk add --no-cache curl git && git clone … && build`。

## 测试

- workflow 本身无单测：验证 `ci-images.txt` 条目可同步 + `sync.sh` 语法；
- 后端/前端无逻辑改动（纯配置与文档），回归 `node --test` + 前端 build 保持绿。

## 迁移与运维

- `DOCKER_USERNAME/DOCKER_PASSWORD` secrets 需在 CloudShuttle 仓库配置（ACR 账号）；
- 手动触发 action → ACR 同步完成 → seed 更新为 ACR 地址后再部署；
- 旧执行记录不迁移。

## 范围外（后续）

- 镜像自定义构建（Dockerfile → 私有仓）与镜像市场概念
- 跨节点工作区共享（如需 → PVC/对象存储另行设计）
- 控制面主动拉取回调（pull 模式，如镜像约束仍痛可再评估）