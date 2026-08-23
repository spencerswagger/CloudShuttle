import { buildGraph, nextReady } from "./dag.js";

// 推进逻辑：载入快照 → 找到下一个 ready 且未 done 节点 → 交给 stepRun
// stepRun 返回：
//   { kind:'done' }                    —— 就地完成
//   { kind:'dispatch', ref }           —— 已派发 ECI，等待内部回调
//   { kind:'wait', ref }               —— 已登记外部 hook 等待
export function createAdvancer({ stepRun, snapshot, record, recordRegistry = async () => {} }) {
  async function advanceOnce({ spec, snap, execId }) {
    const graph = buildGraph(spec);
    const done = new Set(snap.done ?? []);
    let waiting = snap.waiting ?? null;

    if (waiting) {
      // 有正在等待的节点：由 stepRun 的 resume 分支处理（回调场景），这里仅返回现状
      return { spec, snap: { done, waiting }, waiting };
    }

    const ready = nextReady(graph, done);
    for (const nodeId of ready) {
      const node = graph.nodes.get(nodeId);
      const ctx = { done: [...done], spec, execId, recordRegistry };
      const res = await stepRun(node, ctx);
      if (res.kind === "done") {
        done.add(nodeId);
        await record({ execId, nodeId, status: "done", output: res.output });
      } else {
        waiting = nodeId;
        await record({ execId, nodeId, status: res.kind, ref: res.ref });
        break; // 一次推进只发一个等待/派发
      }
    }
    await snapshot(execId, { done: [...done], waiting });
    return { spec, snap: { done, waiting }, waiting };
  }

  return { advanceOnce };
}