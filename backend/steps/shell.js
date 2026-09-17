// stepRun(node, ctx) 的 shell 分支实现（A′ 执行契约：shell ≡ job，k8s Job 单载具）。
//   控制面渲染最终命令（用户命令 + 日志/输出收集 + 回调）直接写入 Pod command，
//   容器内没有任何平台初始化逻辑；镜像即用户选择的语言/自定义镜像。
// 变量机制：把 ctx.environment（扁平变量地图）与节点 p.env 铺平成 env 数组注入容器；
//   引导变量（CLOUDSHUTTLE_*）放在 env 末尾，同名也不可被覆盖（回调鉴权依赖它）。
// 附加凭证：params.credentials 引用 → assembleRunnerCredentials 组装 Secret 数据，
//   文件型按 CRED_FILE_LAYOUT subPath 落盘、短值（ssh 口令）由 secretKeyRef 注入环境变量。

import { renderParams } from "../engine/variables.js";
import { buildSecretVolumes, secretNameFor } from "../providers/k8s.js";
import { assembleRunnerCredentials } from "./runner-creds.js";

// Job 名需符合 DNS-1123（小写字母/数字/'-'，≤63）
export function jobNameFor(execId, nodeId) {
  return `cs${execId}-${String(nodeId ?? "").toLowerCase()}`
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 63);
}

/**
 * 声明 shell 节点的默认输出 key。
 * 优先取用户显式声明的 p.outputs[].key（按声明顺序）；为空时给默认单 key（step_out）。
 * 作用域（variables.resolveScope）用同一规则推断前驱输出，故此处必须与之一致。
 * @param {{outputs?: Array<{key?: string}>}} p 节点 params
 * @returns {string[]}
 */
export function outputKeysOf(p) {
  const keys = Array.isArray(p?.outputs) ? p.outputs.map((o) => o?.key).filter(Boolean) : [];
  return keys.length ? keys : ["step_out"];
}

// 把扁平环境地图（Map 或对象）转换为 [{k,v}, ...] 数组，供 k8s Job 以环境变量读取。
export function envToEntries(environment) {
  if (environment instanceof Map) {
    return [...environment].map(([k, v]) => ({ k, v: String(v) }));
  }
  if (environment && typeof environment === "object") {
    return Object.entries(environment).map(([k, v]) => ({ k, v: String(v) }));
  }
  return [];
}

function numOrUndef(v) {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 生成包装脚本（控制面渲染，写入容器 command）：
 *   用户命令 stdout/stderr 全部进 /tmp/run.log，输出 K=V 约定写 $CLOUDSHUTTLE_OUT_FILE；
 *   结束后 base64 收集输出与日志，按退出码回调 /_/hook/ecidone|fail（token+secret 双因子）。
 * 日志/输出上限 200KB（FC 请求体安全阈值内），超长截断防回调 body 爆炸。
 * @param {string} userCommand
 * @param {{ base: string, execId: string|number, token: string, secret: string }} cb
 * @returns {string} sh -c 脚本正文
 */
export function buildWrapperCommand(userCommand, { base, execId, token, secret }) {
  const cbUrl = (kind) =>
    `${base}/_/hook/${kind}/${execId}?token=${encodeURIComponent(token)}&secret=${encodeURIComponent(secret)}`;
  return [
    `set +e`,
    `{ ${userCommand} ; } > /tmp/run.log 2>&1`,
    `rc=$?`,
    `OUT=$(head -c 204800 "$CLOUDSHUTTLE_OUT_FILE" 2>/dev/null | base64 -w0)`,
    `LOG=$(head -c 204800 /tmp/run.log | base64 -w0)`,
    `if [ $rc -eq 0 ]; then`,
    `  curl -fsS -X POST "${cbUrl("ecidone")}" -H 'content-type: application/json' -d "$(printf '{"result":{"output":"%s","logs":"%s"}}' "$OUT" "$LOG")"`,
    `else`,
    `  curl -fsS -X POST "${cbUrl("fail")}" -H 'content-type: application/json' -d "$(printf '{"reason":"exit %s","logs":"%s"}' "$rc" "$LOG")"`,
    `fi`,
    `exit $rc`,
  ].join("\n");
}

export function makeShellStep({ k8sProvider, genToken, controlPlaneBase, getK8s, getCredential, assembleCreds = assembleRunnerCredentials }) {
  return async function shellStep(node, ctx) {
    const p = node.params;
    const credential = p?.credential;
    if (!credential) throw new Error("Shell 节点未选择 Kubernetes 集群凭证");
    const kube = await getK8s(credential); // { server, namespace, ...鉴权 }（kubeconfig 已解析）
    // params 深渲染：命令/env/附加凭证引用里的 ${变量} 全部替换（outputs 声明不渲染）
    const rendered = renderParams(p, ctx.environment instanceof Map ? ctx.environment : new Map(Object.entries(ctx.environment ?? {})));

    const base = typeof controlPlaneBase === "function" ? controlPlaneBase(ctx) : controlPlaneBase;
    const token = genToken();
    const secret = genToken(); // 回调独立密钥，防 URL 篡改
    // 引导变量（末尾覆盖：environment/节点 env 同名也不得盖过回调鉴权与输出约定）
    const controlEnv = [
      { k: "CLOUDSHUTTLE_OUT_FILE", v: "/tmp/out" },
      { k: "CLOUDSHUTTLE_TOKEN", v: token },
      { k: "CLOUDSHUTTLE_CB_SECRET", v: secret },
      { k: "CLOUDSHUTTLE_CB_BASE", v: base },
      { k: "CLOUDSHUTTLE_EXEC_ID", v: String(ctx.execId) },
    ];

    // 附加凭证 → Secret：文件型落盘、短值 secretKeyRef 进 env；装配失败（凭证被删/类型不符）
    // 直接抛错 → 节点随 fail 推进（不建 Job），由引擎把执行标记失败，不会悬挂在 waiting。
    const secretName = secretNameFor(jobNameFor(ctx.execId, node.id));
    let credData = {};
    let credMounts = [];
    let credEnvRefs = [];
    if (Array.isArray(rendered.credentials) && rendered.credentials.length) {
      const assembled = await assembleCreds({
        refs: rendered.credentials,
        getCredential,
      });
      credData = assembled.data;
      credMounts = assembled.mounts;
      credEnvRefs = assembled.envRefs;
    }

    const command = buildWrapperCommand(rendered.command ?? "", { base, execId: ctx.execId, token, secret });
    const env = [
      ...(Array.isArray(rendered.env) ? rendered.env : []),
      ...envToEntries(ctx.environment),
      // 短值凭据（ssh 口令等）走同名 Secret secretKeyRef，不落明文 env
      ...credEnvRefs.map((e) => ({ k: e.env, fromSecret: secretName, secretKey: e.key })),
      ...controlEnv,
    ];
    const hasSecret = Object.keys(credData).length > 0 || credEnvRefs.length > 0;
    let secretCreated = false;
    if (hasSecret) {
      await k8sProvider.ensureSecret({ kube, name: secretName, namespace: String(p.namespace ?? "").trim(), data: credData });
      secretCreated = true;
    }
    const { volumes, volumeMounts } = hasSecret ? buildSecretVolumes(secretName, credMounts) : { volumes: [], volumeMounts: [] };
    const { name, uid } = await k8sProvider.createJob({
      kube,
      name: jobNameFor(ctx.execId, node.id),
      namespace: String(p.namespace ?? "").trim(),
      image: rendered.image || "",
      command,
      env,
      volumes,
      volumeMounts,
      secretName: hasSecret ? secretName : undefined,
      // 超时(秒) → Job activeDeadlineSeconds（k8s 单位即秒）；0/空不设置
      activeDeadlineSeconds: numOrUndef(rendered.timeout),
      ttlSecondsAfterFinished: numOrUndef(rendered.ttlSecondsAfterFinished),
      backoffLimit: rendered.backoffLimit != null ? numOrUndef(rendered.backoffLimit) : 0,
    }).catch(async (err) => {
      // 创建 Job 失败回滚：删掉已建的凭据 Secret，避免孤儿敏感数据残留
      if (secretCreated) {
        await k8sProvider.deleteSecret({ kube, name: secretName, namespace: String(p.namespace ?? "").trim() });
      }
      throw err;
    });
    if (hasSecret && uid) {
      // 把 Secret 挂到 Job 的 ownerReferences：TTL 清理 Job 时随 GC 删除（attach 失败只告警不阻断）
      await k8sProvider.attachSecretOwnerRef({
        kube, namespace: String(p.namespace ?? "").trim(),
        secretName, jobName: name, jobUid: uid,
      });
    }
    await ctx.recordRegistry({ kind: "job", token, secret, execId: ctx.execId, nodeId: node.id });
    // 声明输出 key：回调侧按此校验 parseOutput，并把 K=V 写回 environment 供后继节点引用
    return { kind: "dispatch", ref: name, outputKeys: outputKeysOf(p) };
  };
}