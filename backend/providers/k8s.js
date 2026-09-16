// Kubernetes 凭证解析与极简客户端（JOB 节点用 k8s Job 承载 runner）。
// kubeconfig = 完整 YAML（token / client-cert / basic 三种鉴权），后端据此直连集群 API。
// 为便于单测：解析/鉴权/Job manifest 均为纯函数导出，HTTP 客户端通过注入的 buildClient 替换。
import yaml from "yaml";
import https from "node:https";
import axios from "axios";

// ---------- kubeconfig 解析（纯函数） ----------
export function parseKubeconfig(text) {
  let doc;
  try {
    doc = yaml.parse(String(text));
  } catch (e) {
    throw new Error(`kubeconfig 不是合法 YAML：${e?.message ?? e}`);
  }
  const ctxName = doc?.["current-context"];
  const ctx = (Array.isArray(doc?.contexts) ? doc.contexts : []).find((c) => c?.name === ctxName);
  if (!ctx?.context?.cluster || !ctx?.context?.user) {
    throw new Error(`kubeconfig 缺少 current-context（或该 context 未指定 cluster/user）`);
  }
  const cluster = (Array.isArray(doc?.clusters) ? doc.clusters : []).find((c) => c?.name === ctx.context.cluster)?.cluster;
  const user = (Array.isArray(doc?.users) ? doc.users : []).find((u) => u?.name === ctx.context.user)?.user;
  if (!cluster?.server) {
    throw new Error(`kubeconfig 集群 ${ctx.context.cluster} 缺少 cluster.server`);
  }
  for (const proto of ["https://", "http://"]) {
    if (cluster.server.startsWith(proto)) break;
    if (proto === "http://") throw new Error(`cluster.server 必须是 http(s):// 地址`);
  }
  return {
    server: cluster.server,
    caData: cluster["certificate-authority-data"],
    insecure: cluster["insecure-skip-tls-verify"] === true,
    token: user?.token,
    clientCertData: user?.["client-certificate-data"],
    clientKeyData: user?.["client-key-data"],
    username: user?.username,
    password: user?.password,
    namespace: ctx.context.namespace ?? "default", // kubeconfig 上下文默认命名空间
  };
}

// 错误脱敏：应答/驱动首行可能带内网 API 地址与账号，剥掉保留可读错误码
export function k8sErrorHint(err, server) {
  let msg = String(err?.response?.data?.message ?? err?.message ?? err)
    .split("\n")[0]
    .slice(0, 300);
  if (server) msg = msg.split(server).join("<host>");
  msg = msg
    .replace(/https?:\/\/[^\s"']+/g, "<host>")
    .replace(/(\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?/g, "<host>")
    .replace(/user ["']?[^"'\s]+["']?/gi, "user <account>");
  return msg;
}

// ---------- 客户端（注入 buildClient 便于单测） ----------
export function buildK8sClient(kube) {
  const agent = new https.Agent({
    rejectUnauthorized: kube.insecure ? false : true,
    ...(kube.caData ? { ca: Buffer.from(kube.caData, "base64") } : {}),
    ...(kube.clientCertData ? { cert: Buffer.from(kube.clientCertData, "base64") } : {}),
    ...(kube.clientKeyData ? { key: Buffer.from(kube.clientKeyData, "base64") } : {}),
  });
  const client = axios.create({
    httpsAgent: agent,
    baseURL: kube.server,
    timeout: 15_000,
    headers: kube.token ? { Authorization: `Bearer ${kube.token}` } : {},
  });
  if (kube.username) {
    client.interceptors.request.use((cfg) => {
      cfg.auth = { username: kube.username, password: kube.password ?? "" };
      return cfg;
    });
  }
  return client;
}

// ---------- Job manifest 组装（纯函数，含 runner 契约） ----------
export function k8sJobManifest({ name, namespace, image, env, activeDeadlineSeconds, ttlSecondsAfterFinished, backoffLimit = 0 }) {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace },
    spec: {
      backoffLimit,
      ...(activeDeadlineSeconds != null ? { activeDeadlineSeconds } : {}),
      ...(ttlSecondsAfterFinished != null ? { ttlSecondsAfterFinished } : {}),
      template: {
        spec: {
          restartPolicy: "Never", // 容器退出即 Pod 结束；不重启（失败重试会重复回调控制面）
          containers: [
            {
              name: "runner",
              image,
              command: ["/bin/sh", "/app/run.sh"], // 与 runner/Dockerfile ENTRYPOINT 一致：拉命令→执行→回调
              env: (Array.isArray(env) ? env : [])
                .map((e) => ({ name: e?.k, value: String(e?.v ?? "") }))
                .filter((e) => e.name),
            },
          ],
        },
      },
    },
  };
}

// ---------- provider ----------
export function createK8sProvider({ buildClient = buildK8sClient } = {}) {
  return {
    // 连通性探测：能列出 namespaces 即认为可达（凭证保存/表单测试连接使用）
    async ping(kube) {
      const client = buildClient(kube);
      const resp = await client.get("/api/v1/namespaces", { timeout: 8_000 });
      return resp?.status === 200;
    },
    // 创建一次性 Job；返回 { name, uid }，失败抛可读错误（脱敏 cluster server/账号）
    async createJob({ kube, name, namespace, image, env, activeDeadlineSeconds, ttlSecondsAfterFinished, backoffLimit }) {
      const client = buildClient(kube);
      const ns = namespace || kube.namespace || "default";
      const manifest = k8sJobManifest({
        name, namespace: ns, image, env,
        activeDeadlineSeconds, ttlSecondsAfterFinished, backoffLimit,
      });
      let resp;
      try {
        resp = await client.post(`/apis/batch/v1/namespaces/${encodeURIComponent(ns)}/jobs`, manifest);
      } catch (err) {
        throw new Error(`创建 Kubernetes Job 失败：${k8sErrorHint(err, kube.server) || "未知错误"}`);
      }
      return { name, uid: resp?.data?.metadata?.uid ?? null };
    },
  };
}