// JOB 节点的 stepRun 实现：以 k8s Job 承载 runner（复用 shell/ECI 的运行契约）。
// Job 容器镜像默认 cloudshuttle/runner:0.1（ENTRYPOINT=run.sh）：拉取控制面命令 → 执行 →
// 完成后回传 /_/hook/ecidone|fail（输出 K=V + 日志），引擎续跑与 shell 完全一致。
import { outputKeysOf, envToEntries } from "./shell.js";
import { coerceTimeout } from "./sql.js";

// Job 名需符合 DNS-1123（小写字母/数字/'-'，≤63）
export function jobNameFor(execId, nodeId) {
  return `cs${execId}-${String(nodeId ?? "").toLowerCase()}`
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 63);
}

function numOrUndef(v) {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function makeJobStep({ k8sProvider, genToken, controlPlaneBase, getK8s }) {
  return async function jobStep(node, ctx) {
    const p = node.params;
    const credential = p?.credential;
    if (!credential) throw new Error("Job 节点未选择 Kubernetes 凭证");
    const kube = await getK8s(credential); // { server, namespace, ...鉴权 }（kubeconfig 已解析）

    const base = typeof controlPlaneBase === "function" ? controlPlaneBase(ctx) : controlPlaneBase;
    const token = genToken();
    const secret = genToken(); // 回调独立密钥，防 URL 篡改
    const jobUrl = `${base}/_/hook/job/${token}`;
    const callbackUrl = `${base}/_/hook/ecidone/${ctx.execId}?token=${token}&secret=${secret}`;
    const controlEnv = [
      { k: "CLOUDSHUTTLE_JOB_URL", v: jobUrl },
      { k: "CLOUDSHUTTLE_OUT_FILE", v: "/tmp/out" },
      { k: "CLOUDSHUTTLE_TOKEN", v: token },
      { k: "CLOUDSHUTTLE_CB_SECRET", v: secret },
      { k: "CLOUDSHUTTLE_CB_BASE", v: base },
      { k: "CLOUDSHUTTLE_EXEC_ID", v: String(ctx.execId) },
      { k: "CLOUDSHUTTLE_NODE_ID", v: node.id },
    ];
    const env = [...controlEnv, ...(Array.isArray(p.env) ? p.env : []), ...envToEntries(ctx.environment)];

    const { name } = await k8sProvider.createJob({
      kube,
      name: jobNameFor(ctx.execId, node.id),
      namespace: String(p.namespace ?? "").trim(),
      image: p.image || "cloudshuttle/runner:0.1",
      env,
      // 超时(秒) → Job activeDeadlineSeconds；0/空不设置
      activeDeadlineSeconds: coerceTimeout(p.timeout),
      ttlSecondsAfterFinished: numOrUndef(p.ttlSecondsAfterFinished),
      backoffLimit: p.backoffLimit != null ? numOrUndef(p.backoffLimit) : 0,
    });
    await ctx.recordRegistry({ kind: "job", token, secret, execId: ctx.execId, nodeId: node.id });
    return { kind: "dispatch", ref: name, outputKeys: outputKeysOf(p) };
  };
}