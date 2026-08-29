import { buildGraph, nextReady } from "./dag.js";
import { renderParams } from "./variables.js";

// 推进逻辑：载入快照 → 找到下一个 ready 且未 done 节点 → 交给 stepRun
// stepRun 返回：
//   { kind:'done' }                    —— 就地完成
//   { kind:'dispatch', ref }           —— 已派发 ECI，等待内部回调
//   { kind:'wait', ref }               —— 已登记外部 hook 等待

// 把扁平环境源（Map 或对象）写入 env Map；值统一转字符串。
function fillEnv(env, src) {
  if (src instanceof Map) {
    for (const [k, v] of src) env.set(k, String(v));
  } else if (src && typeof src === "object") {
    for (const [k, v] of Object.entries(src)) env.set(k, String(v));
  }
}

// 深 walk 预渲染节点 params：见 variables.js 的 renderParams，返回全新副本，不改动原始 node。
export function createAdvancer({ stepRun, snapshot, record, recordRegistry = async () => {}, complete = async () => {} }) {
  async function advanceOnce({ spec, snap, execId, environment }) {
    const graph = buildGraph(spec);
    const done = new Set(snap.done ?? []);
    let waiting = snap.waiting ?? null;

    // environment 恢复：先用 snap.environment（扁平对象）填充基础值，若外部又显式传入同名则外部优先（覆盖）。
    const env = new Map();
    fillEnv(env, snap.environment);
    fillEnv(env, environment);
    const toFlat = () => Object.fromEntries(env);

    if (waiting) {
      // 有正在等待的节点：内部回调续跑场景由回调后再次注入，本次仅返回现状，不再推进
      console.log(`[advance] exec=${execId} 存在等待回调的节点 node=${waiting}，本次不推进，已结束节点数=${done.size}`);
      return { spec, snap: { done, waiting, environment: toFlat() }, waiting };
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
      // 预渲染：把当前 environment 的 ${name} 替换进节点字符串参数（及 env[].v），传给 stepRun 的为渲染后副本
      const renderedNode = { ...node, params: renderParams(node.params, env) };
      console.log(`[advance] exec=${execId} ⟶ 开始执行就绪节点 node=${nodeId} type=${node.type}`);
      const ctx = { done: [...done], spec, execId, recordRegistry };
      const res = await stepRun(renderedNode, ctx);
      if (res.kind === "done") {
        done.add(nodeId);
        // 节点输出（扁平 K=V）写入 environment，供后续节点 ${name} 引用
        fillEnv(env, res.output);
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
      await snapshot(execId, { done: [...done], waiting: null, status: "completed", environment: toFlat() });
      console.log(`[advance] exec=${execId} ✅ 全部 ${graph.nodes.size} 个节点已完成 → 执行标记为 completed，更新流水线运行状态`);
      await complete({ execId, status: "completed" });
      return { spec, snap: { done, waiting: null, status: "completed", environment: toFlat() }, waiting: null };
    }

    await snapshot(execId, { done: [...done], waiting, environment: toFlat() });
    return { spec, snap: { done, waiting, environment: toFlat() }, waiting };
  }

  return { advanceOnce };
}