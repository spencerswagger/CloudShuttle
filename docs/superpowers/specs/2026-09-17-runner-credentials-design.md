# runner 型节点附加业务凭证（ssh / maven / docker-registry / npm / s3）设计

日期：2026-09-17

## 背景

shell（ECI 载具）与 job（k8s Job 载具）节点把命令放进 runner 容器执行。
业务上容器内经常需要私有仓库访问（git clone、mvn 私服、docker push、npm 私源、对象存储）。
已有的 `docker-registry` / `s3` 凭证此前只存储不下发，本次补齐「凭证真正注入容器」的通用机制，
并新增 `ssh` / `maven` / `npm` 三种凭证类型。

选型（已与用户确认）：

1. 下发机制：**runner 扩展落盘**（升级 runner 镜像到 0.2），凭证随命令经 `/_/hook/job/:token` 内部鉴权通道下发；
2. SSH 用途：**git 私库拉取为主**（私钥 + known_hosts + 可选口令）；
3. Docker：**配置/发布用**（容器内 docker build/push 直接可用，先做登录，imagePullSecret 后续）；
4. 凭证清单：ssh / maven / Docker 私有仓库 / npm（s3 已有、同机制顺带落地）。

## 机制

```
节点 params.credentials=[{name}] ── 保存校验（存在&类型允许）
                │
控制面 getJob（/_/hook/job/:token，Bearer 鉴权）
  按节点引用实时解密凭证 → body.credentials = { ssh?, maven?, docker?, npm?, s3? }
                │
runner v0.2（run.sh）按类型落盘（权限 0600/700，容器用完即毁）：
  ssh   → ~/.ssh/id_rsa + known_hosts（缺省 accept-new）+ GIT_SSH_COMMAND；口令走 SSH_ASKPASS
  maven → ~/.m2/settings.xml（<servers> + 可选 <mirrors>）
  docker→ ~/.docker/config.json（auths，免 docker login 网络调用）
  npm   → ~/.npmrc（//<host>/:_authToken=）
  s3    → /root/.s3cfg（s3cmd）
```

## 组件

- `backend/steps/runner-creds.js`（新）：
  - `RUNNER_CRED_KINDS`：`["ssh","maven","docker-registry","npm","s3"]`；
  - `assembleRunnerCredentials({refs, getCredential})`：按类型映射短 key（docker-registry→docker）并透传字段；
  - `validateCredRefs(spec, lookupCred)`：保存前静态校验（存在 + 类型允许），供 api.js 复用。
- `handlers/api.js`：`assertCredsResolved` 在 create/update 流水线时执行（422 CRED_UNRESOLVED）。
- `index.js` getJob：节点声明了 credentials 时实时解密组装进响应；装配失败（凭证已删/类型不符）
  降级为立即失败命令（`echo 错误; exit 127`），保证节点必随 fail 回调推进、不悬挂 waiting。
  凭证密文不落调度日志与探针。
- `runner/run.sh`（v0.2）：新增 `setup_all_creds`；无 credentials 字段时全跳过（兼容旧控制面）。
- 镜像 tag：runner 0.1 → 0.2（`runner/images.json`、`deploy/seed.sql`、前端 job 节点默认镜像同步）；
  shell 默认镜像取自镜像库（种子已更新）。

## 凭证类型字段（前端 kinds.js）

| 类型 | 字段 |
|---|---|
| ssh | privateKey(textarea,secret,必填)、passphrase(secret,可选)、knownHosts(textarea,secret,可选) |
| maven | serverId(必填)、username(必填)、password(secret,必填)、registryUrl(可选→mirrors) |
| npm | registry(必填)、token(secret,必填) |
| docker-registry | registry、username、password（已有，接入） |
| s3 | endpoint、bucket、ak、sk（已有，接入） |

全部走现有 SM4 secret_enc 链路，不可回显。

## 节点表单（shell / job）

「附加凭证（注入容器）」行内 checkbox 多选，候选 = 允许类型的全部凭证；选中项以 `params.credentials=[{name}]`
入库（保存时后端校验）。

## 安全

- 凭证只在拉取命令的内部端点（`/_/` 仅内网 + token/secret 双因子）下发；调度日志/探针不回显；
- 落盘权限收紧（私钥/配置 0600、目录 700）；容器为一次性，退出即销毁；
- 错误消息不含凭证明文（仅提示名/类型）。

## 测试

- `steps/runner-creds.test.js`：类型映射与透传、空引用忽略、缺失/非法类型报错、validateCredRefs 通过/拦截。
- 后端全量 `node --test` 通过；前端 `npm run build` 通过；`runner/run.sh` `sh -n` 语法校验。

## 范围外（v1 不做）

git-token/pypi、Docker imagePullSecret（k8s Job 拉私有镜像）、SSH Agent 转发/跳板、凭证解密结果写入
调度日志。