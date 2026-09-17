# k8s Job 执行契约重构 + ECI/runner 下线 设计

日期：2026-09-17
状态：待审核

## 背景与目标

当前 shell（ECI 载具）与 job（k8s Job 载具）节点依赖「runner 镜像」承载平台执行契约
（拉命令 → 执行 → curl 回调），导致：

1. 节点实际只能跑 runner 镜像，「语言镜像」（node/golang/python/java）形同虚设；
2. 平台逻辑演进必须重构建并手动推送 runner:0.2 镜像，Pod 起来了却没回调（本次事故）；
3. 两套载具（ECI/k8s）维护成本高，项目未 release，可安全收敛。

目标（已与用户确认）：

- **统一 k8s 单载具**：shell 与 job 节点统一以 k8s Job 执行；**ECI 全量下线删除**；
- **A′ 执行契约（命令内联）**：控制面渲染最终命令直接写入 Pod spec，回调/环境/输出全走
  命令包装与 env，**容器内没有任何平台初始化逻辑**；
- **凭据 → k8s Secret**：控制面建 Job 时同 ns 建同名 Secret（ownerReference 绑定），
  文件型凭据 volumeMount 落盘、短值 secretKeyRef 进 env；TTL 清理 Job 时 Secret 随 owner GC 删除；
- **runner 镜像直接删除**（非可选保留）：runner/ 目录、镜像种子、默认值、前端入口全部移除；
- **kubeconfig 权限文档**：凭证创建页弹窗完整说明所需 RBAC 与创建步骤。

## 已确认决策（2026-09-17 用户拍板）

1. **shell ≡ job**：前后端合并为单一「Shell 执行」节点；平台不暴露载具实现细节，
   用户只需填"命令/镜像/凭证/环境/输出"。后端 STEP_TYPES/步骤实现收敛为一个；
2. **`/_/hook/job/:token` 端点直接删除**（命令已内联，无引用即删；连带 runner 拉取
   环境变量 CS_JOB_URL 一并移除）；
3. **ECI 全量删除**：providers/eci.js、eci 凭证、/api/eci/*、ALIYUN_* 配置、前端 ECI
   表单/探测/规格全部移除；
4. 项目未 release：**不做兼容**，决定砍就删、没用就删（存量数据同样清理，测试环境自用）。

## 执行契约（A′）

```
控制面（buildApp.job / shell 统一走 makeJobStep）
  ├─ renderParams 渲染最终 command、env（含 CLOUDSHUTTLE_* 引导变量）
  ├─ 凭据 assemble → 创建 Secret secret-<jobName>（ownerReferences=Job）
  └─ 创建 Job：
       command: [ "sh", "-c", 包装脚本 ]
       主容器镜像 = 用户在节点上选择的镜像（默认不再绑定 runner）
       env: 引导变量 + 节点 env + environment + 凭据 secretKeyRef
       volumes: secret-<jobName> → 按类型挂载到约定路径
       restartPolicy: Never, backoffLimit: 0, ttlSecondsAfterFinished, activeDeadlineSeconds
```

**包装脚本（控制面生成，写入 container command）**：
```sh
set +e
{ <用户命令> ; } > /tmp/run.log 2>&1
rc=$?
# 输出 K=V：约定 /tmp/out 由用户命令写入（echo "k=v" >> /tmp/out）
OUT=$(cat /tmp/out 2>/dev/null | base64 -w0)
LOG=$(base64 -w0 < /tmp/run.log)
BODY=$(printf '{"result":{"output":"%s","logs":"%s"}}' "$OUT" "$LOG")
if [ $rc -eq 0 ]; then
  curl -fsS -X POST "${CS_CB_BASE}/_/hook/ecidone/${CS_EXEC_ID}?token=${CS_TOKEN}&secret=${CS_SECRET}" -d "$BODY"
else
  curl -fsS -X POST "${CS_CB_BASE}/_/hook/fail/${CS_EXEC_ID}?token=${CS_TOKEN}&secret=${CS_SECRET}" \
    -d "{\"reason\":\"exit $rc\",\"logs\":\"$LOG\"}"
fi
exit $rc
```
- 镜像要求：**/bin/sh + curl**（语言镜像普遍满足；文档标注）；输出约定维持 `$CLOUDSHUTTLE_OUT_FILE`
  兼容（v1 固定 /tmp/out，env 仍下发该变量名）。
- 日志量：base64 进 body；控制面侧对超大日志做截断/降级（沿用现有 eciDone 处理）。

**凭据 Secret 布局（约定路径）**：
| 类型 | volumeMount 路径（文件） | 或 secretKeyRef env |
|---|---|---|
| ssh | /root/.ssh/id_rsa、/root/.ssh/known_hosts | CS_SSH_PASSPHRASE |
| maven | /root/.m2/settings.xml | — |
| docker-registry | /root/.docker/config.json | — |
| npm | /root/.npmrc | — |
| s3 | /root/.s3cfg | — |

## 后端改动

- `providers/k8s.js`
  - `k8sJobManifest` 重构：接收渲染后的 command/env/secret 卷配置；不再硬编码 runner run.sh；
    增加 emptyDir 不需要（无 init）；保留 restartPolicy/backoffLimit/TTL/activeDeadlineSeconds。
  - `createK8sProvider` 增加 `ensureSecret`（create secret-<jobName>，ownerReferences）+ 失败回滚
    （createJob 抛错时删除已建 Secret）。
- `steps/job.js`（shell 与 job 共用一份，改名/保留 makeJobStep 出口）
  - 渲染：`rendered = renderParams(node.params, env)`（命令/环境/凭据引用都渲染）；
  - 引导 env 同前（CS_JOB_URL 不再需要——命令已内联，可移除；保留 CS_EXEC_ID/TOKEN/SECRET/CB_BASE/OUT_FILE）；
  - 凭据池：`assembleRunnerCredentials` → `buildSecretPayload(kind, secret)`（值 base64/文本）；
  - 输出/日志约定不变（outputKeysOf）。
- `steps/runner-creds.js`：返回结构改为「Secret 卷数据」字典（每类型一个挂载路径映射）。
- `index.js`
  - `getJob`（/_/hook/job/:token）**不再使用**：命令已内联。保留端点做兼容（返回原 job spec）
    还是删除由实现期定（无引用即可删，ops：安全起见一期保留返回 410）。
  - `steps` 装配：shell 与 job 都用 makeJobStep（getK8s 相同）；STEP_TYPES 保留 shell/job 两个
    类型名（前端兼容），执行语义一致。
- **ECI 下线（一期全删）**：`providers/eci.js`、eci 凭证 kind、`/api/eci/*` 路由与 handler、
  `ALIYUN_*` 配置、前端 ECI 表单字段与探测；`credential` 表既有 eci 行保留数据不动（仅前端不再提供）。
- **runner 删除**：`runner/` 目录、`runner/images.json` 中 runner 条目、deploy/seed 的
  Docker+Git 构建行、前端 shell/job 默认镜像改为空/提示选语言镜像、`job.js`/`addNode` 默认值去掉 runner。

## 前端改动

- 节点表单（shell 与 job 合并语义）：凭证= k8s、命名空间、镜像（下拉语言镜像 + 自定义输入）、
  命令、env、附加凭证（Secret 注入勾选）、输出、超时/backoffLimit/TTL；移除 ECI 专属区块。
- 凭证页
  - k8s 类型表单下方新增「📖 权限与 kubeconfig 说明」**弹窗**：
    - 所需 RBAC（最小权限清单 + 完整示例二选一）：jobs/secrets 的
      `create/get/list/watch/delete`、pods 的 `get/list/watch`（日志/状态可选）、
      `namespaces get`；（示例 ClusterRole YAML 可复制）
    - 创建步骤：建 SA → 绑定 Role/ClusterRole → 生成 kubeconfig（token 或 client-cert 两种贴法）
      → 用 `kubectl auth can-i` 自检清单；
    - 集群可达性注意事项（公网端点/同 VPC）。
  - 弹窗实现独立组件 `K8sPermissionGuide.vue`（内容走 data 常量，便于维护）。
- 镜像管理页：语言镜像说明改为「节点镜像即用户业务镜像，直接选择语言/自定义镜像」；
  移除 runner「Docker+Git 构建」种子概念的文案。
- 执行详情：kindLabel 调整（shell==job 统一展示镜像/命令），无功能阻塞。

## 测试

- k8s.test：`k8sJobManifest` 命令内联、Secret 卷挂载、ownerReferences、TTL/backoffLimit；
  `ensureSecret` + createJob 失败回滚（fake client 断言顺序/删除调用）。
- job.test：渲染后的 command 直接进入 manifest；env 引导变量；Secret payload 组装
  （ssh/maven/docker/npm/s3 各挂载路径）；无 runner 引用。
- 移除 eci/runner 相关旧测试与快照断言；node --test 全绿；前端 build。
- ECI 相关单测文件删除或改跳（eci.test.js 等随代码删除）。

## 迁移与运维

- shell 节点历史数据（含 `/_/hook/job` 引用、运行中执行）不做兼容，直接随版本换代；
  kubeconfig 权限文档即本设计的交付物之一，部署后凭证页弹窗可见。

## 范围外（后续）

Secret 加密存储（etcd 静态加密依赖集群侧）、多 Pod 并行、Pod 级资源 requests/limits、
事件日志流式展示、控制面主动轮询 Job。