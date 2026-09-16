# k8s 凭证（kubeconfig）+ JOB 节点（k8s Job）设计

日期：2026-09-16

## 背景

控制面已具备 shell（阿里云 ECI）、approval（钉钉）、sql（mysql/pg）三类执行节点。
本设计新增：

- 凭证类型 `k8s`：保存一份完整 kubeconfig YAML（SM4 加密落库），指向任意 Kubernetes 集群；
- 节点类型 `job`：以 k8s Job 作为运行载体，命令执行/完成回调/输出日志回传完全复用现有 shell/ECI 的 runner 契约。

选型（已与用户确认）：

1. 命令执行复用 **runner 包装**（Job 容器跑 `cloudshuttle/runner:0.1`，拉取命令执行后自行回调控制面）；
2. 凭证形态为**完整 kubeconfig YAML**（后端引入轻量 `yaml` 解析）；
3. Job 规格 **v1 精简**：命名空间、镜像、命令、env、输出、超时 + 可选 backoffLimit / TTL。

## 架构

```
Flow 编辑页 ──▶ backend (FC) ──▶ k8s API（凭证 kubeconfig 指定）
                    │                  │ 创建 Job（容器=runner）
                    │ recordRegistry   ▼
                    │ (kind=job)   Job 容器：run.sh 拉命令→执行→
                    │                  curl /_/hook/ecidone|fail（输出+日志）
                    └──────────引擎续跑◀─┘
```

与 shell/ECI 的差异仅在「载具」：ECI 容器组 → k8s Job；token/secret 登记、回调校验、
`/_/hook/job/:token` 拉取命令、`onEciDone` 解析写回全部复用。

## 1. 凭证 `k8s`

- 前端 `kinds.js`：`k8s` → label「Kubernetes 集群」，字段 `kubeconfig`（textarea、secret、必填）+ `namespace`（可选默认命名空间）。
- `CredentialForm`：新增 `type=textarea` 字段渲染；「测试连接」对 k8s 生效。
- 后端存储：`credential.secret_enc = SM4({ kubeconfig, namespace })`（复用现有链路，不回显）。
- `providers/k8s.js`（新）：
  - `parseKubeconfig(text)`：纯函数解析 current-context → cluster/user；支持 token / client-cert-data / basic 三种鉴权、`certificate-authority-data`、`insecure-skip-tls-verify`；返回 `{ server, namespace, ...auth }`。非法 YAML / 缺 current-context / server 非 http(s) 报可读错误。
  - `buildK8sClient(kube)`：axios 实例（httpsAgent：CA 或 insecure；Bearer / basic；15s 超时）。
  - `createK8sProvider({ buildClient })`：`ping`（GET /api/v1/namespaces，凭证测试连接用）、`createJob`（POST /apis/batch/v1/namespaces/{ns}/jobs）。
  - `k8sErrorHint(err, server)`：错误脱敏（集群地址/IP/账号替换为 `<host>` / `<account>`）。

## 2. JOB 节点（类型 `job`）

- `steps/job.js`（新）`makeJobStep({ k8sProvider, genToken, controlPlaneBase, getK8s })`：
  - 校验凭证 kind===`k8s`；`getK8s` 解析 kubeconfig（凭证 namespace 优先于 kubeconfig 上下文）。
  - 引导 env 与 shell 完全一致：`CLOUDSHUTTLE_JOB_URL / OUT_FILE / TOKEN / CB_SECRET / CB_BASE / EXEC_ID / NODE_ID`，其后接 `p.env` + environment。
  - `k8sProvider.createJob`：Job 名 `cs{execId}-{nodeId}`（DNS-1123 净化 ≤63）；容器镜像默认 `cloudshuttle/runner:0.1`，command=`["/bin/sh","/app/run.sh"]`（与 runner Dockerfile ENTRYPOINT 一致）；`restartPolicy=Never`、`backoffLimit` 默认 0（防失败重试重复回调）、`activeDeadlineSeconds=p.timeout`、`ttlSecondsAfterFinished` 可选。
  - `recordRegistry({ kind:'job', ... })`；返回 `{ kind:'dispatch', ref: jobName, outputKeys: outputKeysOf(p) }`。
- `index.js`：
  - `STEP_TYPES` 增加 `job`；`steps.job` 装配 `createK8sProvider()`；
  - `getJob` 拉取命令的 registry 查询放宽 kinds `["eci","job"]`。
- `handlers/internal.js`：`lookupRegistry / validateCallback` 支持 `kinds` 数组；`eciDone / eciFail` 校验 kinds `["eci","job"]`（同一回调端点两个载具共用），引擎续跑零改动。

## 3. 前端

- 节点库：`NODE_KINDS.job`（label「Job 执行」）+ `LIB_TYPES` 加入；
- `addNode` job 默认：`{ credential:"", namespace:"", image:"cloudshuttle/runner:0.1", command:"", env:[], outputs:[{key:"step_out"}], timeout:300, backoffLimit:0, ttlSecondsAfterFinished:"" }`；
- 表单：k8s 凭证下拉（仅 k8s 类）、命名空间、运行镜像、执行命令（autofit + 插入变量）、附加环境变量、输出变量、backoffLimit/TTL、超时；
- 执行详情：`KIND_LABEL/KIND_ACCENT` 增加 job，步骤副标题展示 簇/命名空间/镜像。

## 4. 错误处理与安全

- 凭证解析/建连失败给可读错误；kubeconfig 内网地址与账号在错误消息中一律打码。
- 回调 token+secret 双因子（复用现有 webhook_registry 鉴权）；`/_/` 内部端点仅内网可访问（现有 middleware）。
- 集群可达性：cluster.server 必须对控制面（FC）网络可达（公网端点或同 VPC）——凭证页 hint 说明。

## 5. 测试

- `test/k8s.test.js`：kubeconfig 三形态解析、非法输入报错、Job manifest 组装（runner 契约/env 过滤/默认 backoffLimit/可选规格）、createJob 路径与错误脱敏、ping。
- `steps/job.test.js`：env 引导变量在前 + 节点 env + environment、registry kind=job、默认镜像/backoffLimit=0/timeout→activeDeadlineSeconds、ttl 透传、未选/错误凭证报错、jobNameFor 净化。
- 前端 `npm run build`。

## 6. 范围外（v1 不做）

Job 状态轮询/事件回调、多 Pod 并行、节点级资源 requests/limits、私有镜像仓库 imagePullSecret、k8s 集群事件日志流式展示。