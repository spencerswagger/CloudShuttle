# runner · 执行器镜像

在阿里云 **ECI 弹性容器**内执行重活的镜像：`git clone → 构建 → push 镜像/制品 → kubectl 升级`，跑完即销毁、按秒计费。

## 约定

控制面派发一次性容器时注入如下环境变量，`run.sh` 据此工作：

| 变量 | 用途 |
|---|---|
| `CLOUDSHUTTLE_JOB_URL` | 拉取本次 job 定义（含命令、凭证引用） |
| `CLOUDSHUTTLE_TOKEN` | 鉴权 token（拉 job / 回调） |
| `CLOUDSHUTTLE_EXEC_ID` | 执行实例 ID |
| `CLOUDSHUTTLE_NODE_ID` | 当前节点 ID |
| `CLOUDSHUTTLE_CB_BASE` | 控制面基址，用于拼接 `/_/hook/ecidone|fail` 回调 |

> 注：目前 ECI 派发为**待实现接入点**（`createEciGroup`），run.sh 与 shell step 间的 env 变量对接会在接入时补全。

## 内容

```
runner/
  images.json   # 预置镜像清单（cloudshuttle/runner 等）
  run.sh        # 容器内执行脚本：拉 job → 执行 → 回调
  Dockerfile    # runner 镜像
```

## 构建 / 推送

```bash
docker build -t registry.cn-hangzhou.aliyuncs.com/<ns>/cloudshuttle-runner:0.1 runner/
docker push registry.cn-hangzhou.aliyuncs.com/<ns>/cloudshuttle-runner:0.1
```

预置镜像与 ACR 引用的完整说明见 [deploy/README.md](../deploy/README.md)。