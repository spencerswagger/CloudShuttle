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
    const secret = genToken(); // ECI 回调同样使用独立密钥
    const callbackUrl = `${base}/_/hook/ecidone/${ctx.execId}?token=${token}&secret=${secret}`;
    // 最终 env = 节点自身 p.env + environment 全部项（environment 在尾、同名覆盖优先）
    const env = [...(Array.isArray(p.env) ? p.env : []), ...envToEntries(ctx.environment)];
    const { jobRef } = await eciProvider.dispatch({
      execId: ctx.execId, nodeId: node.id,
      image: p.image, command: p.command, env,
      resource: p.resource, timeout: p.timeout, callbackUrl, token,
    });
    await ctx.recordRegistry({ kind: "eci", token, secret, execId: ctx.execId, nodeId: node.id });
    // 声明输出 key，供后续 ECI 回调侧解析写回 environment（本期只到声明 + 接口层，不做真执行写回）
    return { kind: "dispatch", ref: jobRef, outputKeys: outputKeysOf(p) };
  };
}