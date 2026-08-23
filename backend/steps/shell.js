// stepRun(node, ctx) 的 shell 分支实现：
//   从 ctx 取 eciProvider、execId、nodeId、控制面 base、token 生成器
export function makeShellStep({ eciProvider, genToken, controlPlaneBase }) {
  return async function shellStep(node, ctx) {
    const p = node.params;
    const base = typeof controlPlaneBase === "function" ? controlPlaneBase(ctx) : controlPlaneBase;
    const token = genToken();
    const callbackUrl = `${base}/_/hook/ecidone/${ctx.execId}?token=${token}`;
    const { jobRef } = await eciProvider.dispatch({
      execId: ctx.execId, nodeId: node.id,
      image: p.image, command: p.command, env: p.env ?? [],
      resource: p.resource, timeout: p.timeout, callbackUrl, token,
    });
    await ctx.recordRegistry({ kind: "eci", token, execId: ctx.execId, nodeId: node.id });
    return { kind: "dispatch", ref: jobRef };
  };
}