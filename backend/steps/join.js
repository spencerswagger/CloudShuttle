// join 汇聚节点：等待全部前驱完成（含被跳过的 skipped 节点）后放行，
// 语义由 DAG 依赖 + state.js 的 skipped 传播自然实现，节点本身 no-op。
export function makeJoinStep() {
  return async function joinStep() {
    return { kind: "done", output: {} };
  };
}
