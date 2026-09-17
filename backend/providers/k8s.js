// Kubernetes 凭证解析与极简客户端（Shell 执行节点以 k8s Job 承载，A′ 命令内联契约）。
// kubeconfig = 完整 YAML（token / client-cert / basic 三种鉴权），后端据此直连集群 API。
// 执行契约：控制面渲染最终 command 直接写入 Pod spec，容器内无任何平台初始化逻辑；
// 附加凭证由控制面组装为 Secret（secret-<jobName>），文件型经 subPath 落盘、短值 secretKeyRef 进 env，
// Secret 的 ownerReferences 指向 Job——TTL 清理 Job 时随 owner GC 一并删除。
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

// Job 名需符合 DNS-1123（小写字母/数字/'-'，≤63）；Secret 名 = `secret-<jobName>`
export function secretNameFor(jobName) {
  return `secret-${jobName}`;
}

/**
 * Secret 卷数据 → Pod 的 volumes/volumeMounts（纯函数，便于单测）。
 * secretData：{ key: 文本内容 }（控制面组装；创建 Secret 时由 provider base64 化）。
 * mounts：{ key, mountPath, subPath } —— 单卷 + 多条 subPath 挂载，把密钥文件放到约定路径
 * （~/.ssh/id_rsa、~/.m2/settings.xml 等）。subPath 挂载的密钥在容器启动时即定，Job 一次性运行无需热更新。
 * @returns {{ volumes: Array, volumeMounts: Array }}
 */
export function buildSecretVolumes(secretName, mounts) {
  if (!Array.isArray(mounts) || !mounts.length) return { volumes: [], volumeMounts: [] };
  return {
    volumes: [{ name: "cs-creds", secret: { secretName, items: mounts.map((m) => ({ key: m.key, path: m.subPath })) } }],
    volumeMounts: mounts.map((m) => ({ name: "cs-creds", mountPath: m.mountPath, subPath: m.subPath })),
  };
}

// ---------- Job manifest 组装（纯函数，A′ 命令内联契约） ----------
// env 数组元素：{k,v} → name/value；{k, fromSecret} → valueFrom.secretKeyRef（fromSecret=Secret 名，secretKey=键）
export function k8sJobManifest({ name, namespace, image, command, env, volumes = [], volumeMounts = [], activeDeadlineSeconds, ttlSecondsAfterFinished, backoffLimit = 0 }) {
  const envList = (Array.isArray(env) ? env : [])
    .map((e) => {
      if (!e?.k && !e?.name) return { name: "", value: "" };
      if (e.fromSecret) {
        return {
          name: e.name ?? e.k,
          valueFrom: { secretKeyRef: { name: e.fromSecret, key: e.secretKey ?? e.k, optional: true } },
        };
      }
      return { name: e.k, value: String(e.v ?? "") };
    })
    .filter((e) => e.name);
  const hasVol = Array.isArray(volumes) && volumes.length > 0;
  const hasMounts = Array.isArray(volumeMounts) && volumeMounts.length > 0;
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
          ...(hasVol ? { volumes } : {}),
          containers: [
            {
              name: "shell",
              image,
              // 命令由控制面渲染：用户命令 + 输出/日志收集 + 回调，直接内联，无需平台镜像
              ...(command ? { command: ["sh", "-c", command] } : {}),
              env: envList,
              ...(hasMounts ? { volumeMounts } : {}),
            },
          ],
        },
      },
    },
  };
}

// ---------- provider ----------
export function createK8sProvider({ buildClient = buildK8sClient } = {}) {
  const nsOf = (kube, ns) => ns || kube?.namespace || "default";
  const wrapErr = (err, kube, label) => {
    throw new Error(`${label}：${k8sErrorHint(err, kube?.server) || "未知错误"}`);
  };
  return {
    // 连通性探测：能列出 namespaces 即认为可达（凭证保存/表单测试连接使用）
    async ping(kube) {
      const client = buildClient(kube);
      const resp = await client.get("/api/v1/namespaces", { timeout: 8_000 });
      return resp?.status === 200;
    },
    // 创建凭据 Secret（secret-<jobName>）：data 值传入时 base64 化（K8s Secret.data 规范）
    async ensureSecret({ kube, name, namespace, data }) {
      const client = buildClient(kube);
      const ns = nsOf(kube, namespace);
      const encoded = {};
      for (const [k, v] of Object.entries(data ?? {})) {
        if (v != null) encoded[k] = Buffer.from(String(v), "utf8").toString("base64");
      }
      try {
        await client.post(`/api/v1/namespaces/${encodeURIComponent(ns)}/secrets`, {
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name, namespace: ns },
          type: "Opaque",
          data: encoded,
        });
      } catch (err) {
        wrapErr(err, kube, `创建凭据 Secret 失败`);
      }
      return name;
    },
    // 把 Secret 的 ownerReferences 指向刚创建的 Job（uid 已知后补挂，保证 TTL 清理 Job 时随 GC 删除）
    async attachSecretOwnerRef({ kube, namespace, secretName, jobName, jobUid }) {
      const client = buildClient(kube);
      const ns = nsOf(kube, namespace);
      const patch = {
        metadata: {
          ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name: jobName, uid: jobUid }],
        },
      };
      try {
        await client.patch(`/api/v1/namespaces/${encodeURIComponent(ns)}/secrets/${encodeURIComponent(secretName)}`, patch, {
          headers: { "content-type": "application/merge-patch+json" },
        });
      } catch (err) {
        // 补 ownerRef 失败只是泄漏清理问题，不影响执行本身：记录后放行（Job 完成后由人工/运维兜底清理）
        console.warn(`[k8s] attach ownerRef failed secret=${secretName} job=${jobName}: ${err?.message ?? err}`);
      }
      return secretName;
    },
    // 删除凭据 Secret（createJob 失败回滚用）
    async deleteSecret({ kube, name, namespace }) {
      const client = buildClient(kube);
      const ns = nsOf(kube, namespace);
      try {
        await client.delete(`/api/v1/namespaces/${encodeURIComponent(ns)}/secrets/${encodeURIComponent(name)}`);
      } catch (err) {
        console.warn(`[k8s] delete secret ${name} failed: ${err?.message ?? err}`);
      }
    },
    // 创建一次性 Job；返回 { name, uid }，失败抛可读错误（脱敏 cluster server/账号）
    async createJob({ kube, name, namespace, image, command, env, volumes, volumeMounts, activeDeadlineSeconds, ttlSecondsAfterFinished, backoffLimit }) {
      const client = buildClient(kube);
      const ns = nsOf(kube, namespace);
      const manifest = k8sJobManifest({
        name, namespace: ns, image, command, env, volumes, volumeMounts,
        activeDeadlineSeconds, ttlSecondsAfterFinished, backoffLimit,
      });
      let resp;
      try {
        resp = await client.post(`/apis/batch/v1/namespaces/${encodeURIComponent(ns)}/jobs`, manifest);
      } catch (err) {
        wrapErr(err, kube, `创建 Kubernetes Job 失败`);
      }
      return { name, uid: resp?.data?.metadata?.uid ?? null };
    },
  };
}