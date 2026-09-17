# Shell 执行模型定稿：镜像零依赖回调（pull 模式）+ 单节点聚合 设计

日期：2026-09-18
状态：待审核（用户要求先出设计文档）

## 背景与问题

v0.3.0-rc3 的执行契约是「控制面把命令内联进容器 command，容器执行后 **curl 回调** 控制面」。
实测暴露三点：

1. **镜像工具依赖脆弱**：`node:20-slim` / `python:3.12-slim` 等主流小镜像不自带 curl（slim 系连
   wget 也没有），Pod 打印 `sh: 11: curl: not found`，任务无法回传状态；而完整版镜像（node:20）
   体积 ~1GB，用户不愿接受。
2. **回调方向要求集群→控制面可达**：容器需回调控制面，`/_/` 仅放行内网 IP，导致必须配置
   `CALLBACK_BASE_INTERNAL` 且集群与控制面同 VPC；公网侧集群（ACK 公网端点）回调即 403。
   说明：403 拦截本身是正确安全设计，问题在「回调方向依赖容器主动回拨」这一契约上。
3. **跨节点无工作区共享**：真实 CI（git clone → build → docker build）拆分多个 shell 节点时，
   各节点是独立 Job/独立 Pod/独立临时文件系统，只有 K=V 字符串变量可传。

与用户讨论后拍板（详见「已确认决策」）：不引入工作区共享/共享卷；多步骤由一个节点内串联命令完成；
平台对镜像**零工具要求**，回调改为 **控制面主动拉取**（pull 模式），镜像问题就此根治。

## 已确认决策（2026-09-18 用户拍板）

1. **不做工作区共享**：shell 节点间不共享文件系统；多步骤（clone+build+docker build）由用户
   写在**单个节点**的命令里串联执行（`git clone … && build && docker build`）。跨节点仍是
   K=V 变量（`${name}`）串小数据。不使用 PV/PVC，不做对象存储产物中转。
2. **镜像 = 用户自备**：平台不组装/不审核镜像内容，只透传节点填写的镜像；
   镜像管理页定位为「运行镜像入口」（语言镜像或用户推送的自定义 CI 镜像）。
3. **回调改 pull 模式（本轮核心）**：容器内不再要求任何 HTTP 工具；Job 结束后由**控制面**
   通过 kubeconfig 主动读取 Pod 状态与日志，判定成败并续跑。镜像零依赖。
4. 项目未 release，**不做兼容**；既有的 `CLOUDSHUTTLE_*` 引导变量与 `CALLBACK_BASE_INTERNAL`
   环境变量随契约切换废弃。

## 目标执行契约（v2，pull 模式）

```
控制面（steps/shell.js → k8sProvider）
  ├─ renderParams 渲染用户 command / env / resources / 附加凭证
  ├─ 附加凭证 → 建 Secret（secret-<jobName> 附带凭据卷；机制不变）
  └─ 创建 Job（挂载不变）：
       command: [ "sh", "-c", 包装脚本 ]
       包装脚本 = 只跑用户命令 + 写 /tmp/out + 退出码写 termination message：
         set +e; { 用户命令; } > /tmp/run.log 2>&1; rc=$?; echo "exit $rc" > /dev/termination-log
         cat /tmp/run.log >> /dev/termination-log; exit $rc
       # 容器内没有任何 HTTP 回调、无平台工具要求（sh 即可，任何镜像都满足）
  └─ 注册 registry（kind=job，记录 execId/nodeId/token，用于后续状态拉取鉴权）
```

**状态推进（关键变化：回调 → 主动拉取）**

- Job 派发后节点进入「运行（wait=dispatch）」；此后续跑不再依赖容器回调，而由**控制面轮询器**推进：
  - 轮询器按 registry 中 kind=job 的待完成记录，定时经 kubeconfig `GET pods?label=job-name` 读
    Pod `containerStatuses[].state.terminated`（exitCode）与 `pods/{pod}/log`（完整 stdout/stderr）；
  - Pod 终态：
    - exitCode=0 → markDone 成功；日志经现有 record 落库（完整，无 3MB 截断/body 限制）；
    - exitCode≠0 → 标记 failed（reason=exit N）并 failExecution；
    - 超时（activeDeadlineSeconds 到期）仍无终态 → 按失败处理；
  - 轮询触发载体：控制面新增 `/api/executions/poll`（或 FC 定时触发器）扫描 running 执行中
    kind=job 的 registry 记录逐个拉取；FC 无后台任务，采用「下一次任意请求顺带轮询 + 定时器」双保险。

- 收益：
  - **镜像零要求**：只需 sh（POSIX 壳），slim/alpine/任意自定义镜像均可；node:20-slim 问题消失；
  - **日志完整**：直接读 Pod 日志，替代 base64 回调（3MB 截断、ARG_MAX 规避统统不再需要）；
  - **方向反转**：集群不需回调控制面，公网 ACK 也可（控制面主动连 API），`CALLBACK_BASE_INTERNAL`
    与 `/ _/hook/ecidone|fail` 的容器侧调用可下线（`/_/` 仍仅内网，其余用途保留）。

## 后端改动

- `providers/k8s.js`
  - `createJob` 不变（去 command 包装里回调节点）；新增 `readPodStatus` / `readPodLogs`
    （`GET pods?labelSelector=job-name=<name>` → `GET pods/{pod}/log`），返回
    { exitCode|null, logs }（纯客户端方法，单测注入 buildClient）。
  - `buildSecretVolumes` / ownerReferences / TTL 机制保留。
- `steps/shell.js`
  - `buildWrapperCommand` 简化为「跑命令 + 日志 + termination message + exit rc」，删除 base64 与
    curl 体；移除 `CLOUDSHUTTLE_CB_BASE/TOKEN/CB_SECRET` 引导变量（保留 `CLOUDSHUTTLE_OUT_FILE/
    EXEC_ID` 与资源/超时透传）。
  - `makeShellStep` 派发后按原样 recordRegistry(kind=job)。
- 新增轮询推进：`engine/orchestrator.js` 增加 `pollJobs(execIds)`（或独立 `steps/poller.js`）：
  对等待中的 job 节点逐个读 Pod 状态 → markDone/advance（与回调同锁、同快照合并路径）；
  `index.js` 注册 `GET /api/executions/poll` 与 DISPATCH；本轮实现先挂
  「前端执行列表自动轮询 + manual 触发」，FC 定时触发器第二步落地。
- 移除/废弃：`CALLBACK_BASE_INTERNAL` 配置、容器内回调节点、`/_/hook/ecidone|fail` 的容器调用
  （端点保留履约：registry 空转或用其它用途，见迁移）。

## 前端改动

- Shell 节点表单：镜像说明从「需含 curl」改为「任意含 sh 的镜像」；命令 hint 增加多步骤串联示例
  （clone→build→docker build 一行 `&&` 说明）。
- 执行详情：Job 名/资源/日志展示不变；新增「轮询状态」文案可后置。
- 执行列表：触发一次 `poll` 后再刷新（可选，第二步）。

## 测试

- k8s.test：`readPodStatus`/`readPodLogs` 的 URL 与响应解析；manifest 无回调 command 断言。
- shell.test：wrapper 线性简化断言（无 curl/base64/CB 变量）；poll 推进（fake client 返回
  exitCode → markDone + environment 合并）。
- orchestrator.test：`pollJobs` 对 waiting 节点推进/失败/超时三分支。
- 前端 build。

## 迁移与运维

- 旧执行记录不回填；进行中的旧契约执行由 registry 过期自然结束。
- `CALLBACK_BASE_INTERNAL` 在 FC 环境移除（不再需要）；`/_/` 内网限制不变。
- 部署后示例 `demo-rollout` 直接可用任意镜像（shell 节点选 node:20-slim 也能跑通）。

## 范围外（后续）

- 跨节点工作区共享（若未来需要 → PVC/对象存储，另行设计）
- 轮询频率的动态退避、事件流式展示
- Pod 级资源 requests/limits 分离配置（当前仍 requests==limits）