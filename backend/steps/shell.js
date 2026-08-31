// stepRun(node, ctx) 的 shell 分支实现：
//   从 ctx 取 eciProvider、execId、nodeId、控制面 base、token 生成器
// 变量机制：把 ctx.environment（扁平变量地图）铺平成 {k,v} 追加进派发给 ECI 的 env 数组，
// 供脚本以环境变量读取；节点自身 p.env 在前，environment 变量在后（后者同名覆盖优先）。

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

// 把扁平环境地图（Map 或对象）转换为 [{k,v}, ...] 数组，供 ECI 以环境变量读取。
function envToEntries(environment) {
  if (environment instanceof Map) {
    return [...environment].map(([k, v]) => ({ k, v: String(v) }));
  }
  if (environment && typeof environment === "object") {
    return Object.entries(environment).map(([k, v]) => ({ k, v: String(v) }));
  }
  return [];
}

export function makeShellStep({ eciProvider, genToken, controlPlaneBase }) {
  return async function shellStep(node, ctx) {
    const p = node.params;
    const base = typeof controlPlaneBase === "function" ? controlPlaneBase(ctx) : controlPlaneBase;
    const token = genToken();
    const secret = genToken(); // ECI 回调/job 同样使用独立密钥
    const jobUrl = `${base}/_/hook/job/${token}`;
    const callbackUrl = `${base}/_/hook/ecidone/${ctx.execId}?token=${token}&secret=${secret}`;
    // runner 引导变量：URL 由控制面计算，其余由 run.sh 读取；放在 env 前面（environment 同名也不可覆盖引导契约）
    const controlEnv = [
      { k: "CLOUDSHUTTLE_JOB_URL", v: jobUrl },
      { k: "CLOUDSHUTTLE_OUT_FILE", v: "/tmp/out" },
      { k: "CLOUDSHUTTLE_TOKEN", v: token },
      { k: "CLOUDSHUTTLE_CB_SECRET", v: secret },
      { k: "CLOUDSHUTTLE_CB_BASE", v: base },
      { k: "CLOUDSHUTTLE_EXEC_ID", v: String(ctx.execId) },
      { k: "CLOUDSHUTTLE_NODE_ID", v: node.id },
    ];
    // 最终 env = 引导变量 + 节点自身 p.env + environment 全部项（environment 在尾、同名覆盖优先，但不得盖过引导变量）
    const env = [...controlEnv, ...(Array.isArray(p.env) ? p.env : []), ...envToEntries(ctx.environment)];
    const { jobRef } = await eciProvider.dispatch({
      execId: ctx.execId, nodeId: node.id,
      image: p.image, command: p.command, env,
      resource: p.resource, timeout: p.timeout, callbackUrl, token,
    });
    await ctx.recordRegistry({ kind: "eci", token, secret, execId: ctx.execId, nodeId: node.id });
    // 声明输出 key：ECI 回调侧按此校验 parseOutput，并把 K=V 写回 environment 供后继节点引用
    return { kind: "dispatch", ref: jobRef, outputKeys: outputKeysOf(p) };
  };
}