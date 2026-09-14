// branch 条件分支节点：出边条件求值与 dead 传播由引擎推进层（state.js）完成，
// 节点本身无副作用、无输出，仅作为分支起点标记。
export function makeBranchStep() {
  return async function branchStep() {
    return { kind: "done", output: {} };
  };
}
