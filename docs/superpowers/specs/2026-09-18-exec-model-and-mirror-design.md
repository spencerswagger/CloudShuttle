# Shell 执行模型与镜像供给 定稿设计

日期：2026-09-18（定稿版）
状态：待用户确认后进入实施

## 背景与问题

v0.3.0-rc3 执行契约（命令内联 + curl 回调）实测暴露：

1. **镜像工具依赖脆弱**：`node:20-slim` / `python:3.12-slim` 等小镜像不自带 curl（slim 系连
   wget 也没有），Pod 报 `sh: 11: curl: not found`；完整版镜像（node:20 解压 ~1.7GB）过大。
2. **无现成"小 + 语言 + git + curl"一体镜像**：官方镜像要么大（完整版自带工具）要么缺（slim/alpine
   只有一个运行时，需 `apk/apt` 自装）。
3. **跨节点无工作区共享**：多步骤 CI（git clone → build → docker build）拆节点时无文件共享。
4. **docker build 的隐忧**：k8s Pod 内没有 docker daemon，镜像里装了 docker CLI 也不能直接
   `docker build`。

多轮讨论后拍板：不做工作区共享、回调保持 curl，镜像问题由**镜像供给侧自建多版本镜像**解决。

## 已确认决策（2026-09-18 用户拍板）

1. **不做工作区共享**：节点间不共享文件系统，多步骤由用户写在单个节点命令内串联（`&&`）；
   跨节点仍用 K=V 变量。不用 PV/PVC，不做对象存储产物中转。
2. **回调链路不改**：保持「容器内 curl 回调」；镜像自带 curl 由供给保证。**不引入 pull 回调**。
3. **镜像供给 = 本仓库 Dockerfile 多版本构建**：新增 `docker/` 目录，按「语言 × 大版本」写
   Dockerfile，内置语言运行时 + git + curl（+ 可选 docker/kaniko）；发布链路用**原生 docker**
   （`docker buildx build/push` + ACR 登录），`workflow_dispatch` 手动触发，**不用 skopeo、
   不做官方镜像搬运**。
4. **镜像矩阵（首轮）**：`base` + `java 8→最新稳定大版本` + `node 14→最新稳定大版本` +
   `python 3.7→最新稳定大版本` + `golang 1.19→最新稳定大版本`。
5. 项目未 release，不做兼容。

## 镜像矩阵与 Dockerfile 结构

### 5.1 仓库结构与命名

```
docker/
  base.dockerfile            → registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-base:latest
  java/java8.dockerfile      → registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-java:8
  java/java17.dockerfile     → registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-java:17
  …（每大版本一个文件，tag = 大版本号）
  node/node14.dockerfile     → registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-node:14
  node/node22.dockerfile     → registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-node:22
  …
  python/python3.7.dockerfile → registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-python:3.7
  …
  golang/go1.19.dockerfile   → registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-golang:1.19
  …
```

### 5.2 镜像内容

| 镜像 | 基础 FROM | 内置工具 |
|---|---|---|
| `ci-base:latest` | `alpine:3.20` | curl、git、openssh-client、ca-certificates、make；**不带**语言运行时；额外安装 `docker-cli` 与 `kaniko`（见 5.3） |
| `ci-node:<major>` | `node:<major>-alpine` | + curl、git、openssh-client |
| `ci-python:<ver>` | `python:<ver>-alpine` | + curl、git、openssh-client |
| `ci-golang:<major>` | `golang:<major>-alpine` | + curl、git、openssh-client |
| `ci-java:<major>` | `eclipse-temurin:<major>-jdk`(或 -jre) | + curl、git、openssh-client |

> 语言基座统一用官方镜像；版本演进实现为「新增/更新对应版本 Dockerfile，重新触发构建」。
> Dockerfile 内容基本形态：
> ```dockerfile
> FROM node:20-alpine
> RUN apk add --no-cache curl git openssh-client ca-certificates
> ```

### 5.3 docker build（应用镜像构建）约束

- **无 daemon**：k8s Job 内无 docker daemon，`docker build` 直接不可用；
- **kaniko 补位**：`ci-base` 内置 kaniko 静态二进制（`gcr.io/kaniko-project/executor`），用户
  命令里用 `kaniko --context … --dockerfile … --destination …` 免 daemon 构建；`ci-*` 语言镜像
  如需也可在命令里引用 kaniko（文档给一行模板）。
- docker-cli 客户端仍随 `ci-base` 提供（供 push/pull 私有镜像到 daemon 之外的场景，可选）。

## 发布 workflow（原生 docker）

`.github/workflows/build-ci-images.yml`：

- `workflow_dispatch` 手动触发，输入：
  - `image`：目标镜像标识（如 `node/20` → `ci-node:20`），或 `all` 全量构建；
- **目标地址写死（字面量，不用变量）**：
  `REGISTRY=registry.cn-hangzhou.aliyuncs.com`、`NAMESPACE=spencerswagger`——完整地址形如
  `registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-node:20`，触发时只选镜像；
- 步骤：checkout → `docker login registry.cn-hangzhou.aliyuncs.com`（secrets
  `DOCKER_USERNAME/DOCKER_PASSWORD`）→
  `docker buildx build --platform linux/amd64 -t registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-*:<tag> . -f docker/…`
  → `docker push`；
- `all` 按 Dockerfile 清单逐个构建全部版本。

## 平台接入（执行侧）

- **DB 迁移批量预置镜像**：新增迁移（如 `NNN_ci_images.sql`）按镜像矩阵把全部默认镜像
  （`ci-base:latest`、`ci-node:<全部版本>`、`ci-python:*`、`ci-java:*`、`ci-golang:*`）用
  幂等存在性守卫逐行 `INSERT INTO exec_image`（镜像名唯一，沿用 seed 的守卫写法，存量库升级时
  自动补全、新库也走同一条路径），**用户无需逐个添加**；`deploy/seed.sql` 只保留 demo 管道，
  镜像预置统一由迁移负责（避免双份）。
- 迁移/种子里的镜像地址直接写死为 `registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-*`
  字面量（SQL 可直接复制执行），tag 与镜像矩阵一一对应。
- 前端镜像下拉/占位文案：说明"平台预置 CI 镜像已含 git/curl（+docker-cli/kaniko），可直接
  clone/build；如用自定义镜像需自带 curl"。

## 测试

- workflow 无单测：新增 `docker/` 语法校验（`docker build --check` 或以 `docker build` 冒烟
  base 与 node 首版本）；`ci-images.txt` 改为 Dockerfile 清单由 workflow 读。
- 后端/前端逻辑无改动；回归 `node --test` + 前端 build 保持绿。

## 运维

- CloudShuttle 仓库需配置 `DOCKER_USERNAME / DOCKER_PASSWORD`（ACR 账号）；
- 触发 action 构建 → 推送 → 集群内可直接 `registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-*`。

## 范围外（后续）

- 跨节点工作区共享（如需 → PVC/对象存储）；
- 控制面主动拉取回调（pull，如镜像约束仍痛再评估）；
- 镜像市场/可视化管理页（目前仅 Dockerfile + workflow 管理）。