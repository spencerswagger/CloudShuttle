// loop 循环入口节点：迭代推进由引擎推进层（state.js）状态机完成，
// 节点本身 no-op，仅在循环结束时由引擎补记累积输出。
export function makeLoopStep() {
  return async function loopStep() {
    return { kind: "done", output: {} };
  };
}
