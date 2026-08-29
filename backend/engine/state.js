import { buildGraph, nextReady } from "./dag.js";

// 推进逻辑：载入快照 → 找到下一个 ready 且未 done 节点 → 交给 stepRun
// stepRun 返回：
//   { kind:'done' }                    —— 就地完成
//   { kind:'dispatch', ref }           —— 已派发 ECI，等待内部回调
//   { kind:'wait', ref }               —— 已登记外部 hook 等待
export function createAdvancer({ stepRun, snapshot, record, recordRegistry = async () => {}, complete = async () => {} }) {
  async function advanceOnce({ spec, snap, execId }) {
    const graph = buildGraph(spec);
    const done = new Set(snap.done ?? []);
    let waiting = snap.waiting ?? null;

    if (waiting) {
      // 有正在等待的节点：内部回调续跑场景由回调后再次注入，本次仅返回现状，不再推进
      console.log(`[advance] exec=${execId} 存在等待回调的节点 node=${waiting}，本次不推进，已结束节点数=${done.size}`);
      return { spec, snap: { done, waiting }, waiting };
    }

    const ready = nextReady(graph, done);
    console.log(
      `[advance] exec=${execId} 推进一轮：已结束节点 ${done.size}/${graph.nodes.size}，` +
      `等待=${waiting ?? "无"}，本次就绪可执行节点=[${ready.join(",") || "无"}]`
    );
    if (!ready.length) {
      // 无就绪节点但 done 也未满 → 说明被上游未完成节点挡住（多为 shell/ECI 占位未实现导致）
      console.warn(
        `[advance] exec=${execId} 没有可执行的就绪节点(已结束 ${done.size}/${graph.nodes.size})，` +
        `疑似被上游未完成节点阻塞 nodes=[${[...graph.nodes.keys()].join(",")}] ` +
        `已结束节点 ids=[${[...done].join(",")}]`
      );
    }

    for (const nodeId of ready) {
      const node = graph.nodes.get(nodeId);
      console.log(`[advance] exec=${execId} ⟶ 开始执行就绪节点 node=${nodeId} type=${node.type}`);
      const ctx = { done: [...done], spec, execId, recordRegistry };
      const res = await stepRun(node, ctx);
      if (res.kind === "done") {
        done.add(nodeId);
        console.log(`[advance] exec=${execId} ✔ 节点 ${nodeId} 就地完成，已写入节点记录`);
        await record({ execId, nodeId, status: "done", output: res.output });
      } else {
        waiting = nodeId;
        console.log(
          `[advance] exec=${execId} ⏸ 节点 ${nodeId} 进入${res.kind === "wait" ? "外部等待" : "派发"}状态 ` +
          `ref=${res.ref ?? "-"}，本次推进到此为止，等待外部回调`);
        await record({ execId, nodeId, status: res.kind, ref: res.ref });
        break; // 一次推进只发一个等待/派发
      }
    }

    // 所有节点均已完成任务：标记执行整体完成，并更新流水线的运行状态为 completed
    if (done.size === graph.nodes.size && !waiting) {
      await snapshot(execId, { done: [...done], waiting: null, status: "completed" });
      console.log(`[advance] exec=${execId} ✅ 全部 ${graph.nodes.size} 个节点已完成 → 执行标记为 completed，更新流水线运行状态`);
      await complete({ execId, status: "completed" });
      return { spec, snap: { done: [...done], waiting: null, status: "completed" }, waiting: null };
    }

    await snapshot(execId, { done: [...done], waiting });
    return { spec, snap: { done, waiting }, waiting };
  }

  return { advanceOnce };
}