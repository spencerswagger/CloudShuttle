// trigger 起点节点：触发变量（manual 表单值 / webhook 载荷）已由 hydrateForRun 的
// assembleTriggerEnv 注入执行环境，节点本身无副作用、无输出，仅作为 DAG 起点标记。
export function makeTriggerStep() {
  return async function triggerStep() {
    return { kind: "done", output: {} };
  };
}