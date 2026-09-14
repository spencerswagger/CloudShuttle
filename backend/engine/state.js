import { buildGraph, nextReady } from "./dag.js";
import { renderParams } from "./variables.js";
import { evalCond, buildCondCtx } from "./conditions.js";

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

// waiting 集合化归一：快照 waiting 从「单值字符串」扩展为「数组」（多 ECI 同时等待）。
// 读取时兼容两种格式：null/空 → null（无等待）；字符串（旧快照）→ [该节点]；数组 → 拷贝去重。
export function normalizeWaiting(w) {
  if (w == null) return null;
  const arr = Array.isArray(w) ? [...w] : [String(w)];
  return arr.length ? [...new Set(arr)] : null;
}

// 深 walk 预渲染节点 params：见 variables.js 的 renderParams，返回全新副本，不改动原始 node。
// 注：mutex 参数保留注入位（单测沿用），但 advanceOnce 内部不再自行 acquire——续跑互斥由
// orchestrator 层统一持有（同一把 key "exec-callback"），避免非可重入锁嵌套自锁（死锁）。
export function createAdvancer({ stepRun, snapshot, record, recordRegistry = async () => {}, complete = async () => {}, log = async () => {}, mutex }) {
  async function advanceOnce({ spec, snap, execId, environment }) {
    const graph = buildGraph(spec);
    const done = new Set(snap.done ?? []);
    // 快照字段归一化：条件上下文（trigger_raw/node_outputs）、loop 迭代状态（loops，Task 5 使用）、
    // 被跳过节点集合（skipped）——均为每轮幂等重算的输入，缺省给空值。
    const nodeOutputs = snap.node_outputs ?? {};
    const loops = snap.loops ?? {};
    const skipped = new Set(snap.skipped ?? []);
    // waiting 集合化：兼容旧快照字符串格式（normalizeWaiting 归一为数组/null）
    let waiting = normalizeWaiting(snap.waiting);

    // environment 恢复：先用 snap.environment（扁平对象）填充基础值，若外部又显式传入同名则外部优先（覆盖）。
    const env = new Map();
    fillEnv(env, snap.environment);
    fillEnv(env, environment);
    const toFlat = () => Object.fromEntries(env);

    if (waiting) {
      // 有正在等待的节点（可能多个，多 ECI 并行）：回调续跑由 orchestrator 层 mutex 串行化，
      // 且每个回调只移除自己的 nodeId；只要还有节点在等，本轮的推进就应让位（屏障语义），
      // 否则仍等着的节点会被当作 ready 重复派发（Task 2 收窄针对的重复派发隐患）。
      console.log(`[advance] exec=${execId} 存在等待回调的节点 node=${JSON.stringify(waiting)}，本次不推进，已结束节点数=${done.size}`);
      return { spec, snap: { ...snap, done: [...done], waiting, environment: toFlat() }, waiting };
    }

    const ready = nextReady(graph, done);
    const summary = `已结束 ${done.size}/${graph.nodes.size} 个节点，就绪节点=[${ready.join(",") || "无"}]`;
    await log(execId, `推进一轮：${summary}`);
    console.log(
      `[advance] exec=${execId} 推进一轮：已结束节点 ${done.size}/${graph.nodes.size}，` +
      `等待=${waiting ?? "无"}，本次就绪可执行节点=[${ready.join(",") || "无"}]`
    );
    if (!ready.length && done.size < graph.nodes.size) {
      // 无就绪节点且 done 未满 → 说明被上游未完成节点挡住（多为 shell/ECI 占位未实现导致）
      console.warn(
        `[advance] exec=${execId} 没有可执行的就绪节点(已结束 ${done.size}/${graph.nodes.size})，` +
        `疑似被上游未完成节点阻塞 nodes=[${[...graph.nodes.keys()].join(",")}] ` +
        `已结束节点 ids=[${[...done].join(",")}]`
      );
    }

    // 同轮就绪节点真并发派发：Promise.allSettled 并发执行，各自 try/catch 把失败包进
    // fulfilled 的 {nodeId, error} 结构（allSettled 的 rejected 项不含 nodeId，必须内联捕获）。
    //
    // dispatch 类节点不再收窄（Task 2 曾「每轮仅派发一个」防重复派发，现由两条机制取代）：
    //   1) 派发后立即把 nodeId 追加进 waiting 集合并持久化到快照——已派发节点不再是 ready 可重复派发源；
    //   2) 回调续跑由 orchestrator 层 mutex 串行化，且每个回调只移除自己的 waiting 节点。
    // 故 shell/approval 等所有就绪节点同轮全部派发（各自独立 ECI 容器 + 独立回调 token），多 ECI 并行跑。
    const toRun = ready;

    const results = await Promise.allSettled(
      toRun.map(async (nodeId) => {
        try {
          const node = graph.nodes.get(nodeId);
          const renderedNode = { ...node, params: renderParams(node.params, env) };
          const ctx = { done: [...done], spec, execId, environment: env, recordRegistry };
          await log(execId, `⟶ 开始执行节点 ${nodeId}（类型 ${node.type}）`);
          const res = await stepRun(renderedNode, ctx);
          return { nodeId, res };
        } catch (err) {
          return { nodeId, error: err };
        }
      })
    );
    const waitingNodes = [];
    for (const r of results) {
      const { nodeId, res, error } = r.value;
      if (error) {
        // 失败节点标记为 failed，但不中断同轮其他成功节点
        console.error(`[advance] exec=${execId} 节点 ${nodeId} 并发执行失败: ${error?.message ?? error}`);
        await record({ execId, nodeId, status: "failed", output: { error: error?.message ?? String(error) } });
        continue;
      }
      if (res.kind === "done") {
        const node = graph.nodes.get(nodeId);
        if (node?.type === "loop") {
          // loop 节点由引擎状态机驱动（Task 5），此处不 record、不注入输出
          continue;
        }
        nodeOutputs[nodeId] = res.output ?? {};
        done.add(nodeId);
        fillEnv(env, res.output);
        console.log(`[advance] exec=${execId} ✔ 节点 ${nodeId} 就地完成，已写入节点记录`);
        await record({ execId, nodeId, status: "done", output: res.output, logs: res.logs });
        await log(execId, `✔ 节点 ${nodeId} 完成`);
      } else {
        // dispatch/wait：多节点可同时等待 → 全部追加进 waiting 集合（数组），每个回调各自移除自己的
        waitingNodes.push(nodeId);
        console.log(
          `[advance] exec=${execId} ⏸ 节点 ${nodeId} 进入${res.kind === "wait" ? "外部等待" : "派发"}状态 ` +
          `ref=${res.ref ?? "-"}，等待外部回调`);
        await record({ execId, nodeId, status: res.kind, ref: res.ref });
        await log(execId, `⏸ 节点 ${nodeId} 进入${res.kind === "wait" ? "外部等待" : "派发"}状态，等待回调`);
      }
    }
    if (waitingNodes.length) waiting = waitingNodes;

    // ---- 控制节点：branch 边条件求值 + dead/skipped 传播（每轮幂等重算） ----
    const inactive = new Set(); // "from>to" 边未激活标记
    const edgeKey = (e) => `${e.from}>${e.to}`;
    // 0) 被跳过的 branch：其全部出边视为未激活（从未执行）
    for (const id of skipped) {
      const bn = graph.nodes.get(id);
      if (bn?.type === "branch") {
        for (const e of spec.edges ?? []) if (e.from === id) inactive.add(edgeKey(e));
      }
    }
    // 1) 已完成且未被跳过的 branch 节点：逐出边求值。
    // 条件上下文（trigger_raw/node_outputs/env）与单个 branch 无关，每轮构建一次复用。
    const condCtx = buildCondCtx({ triggerRaw: snap.trigger_raw, nodeOutputs, env: toFlat() });
    for (const bn of graph.nodes.values()) {
      if (bn.type !== "branch" || !done.has(bn.id) || skipped.has(bn.id)) continue;
      for (const e of spec.edges ?? []) {
        if (e.from !== bn.id) continue;
        if (e.cond && !evalCond(e.cond, condCtx)) inactive.add(edgeKey(e));
      }
    }
    if (inactive.size) {
      // 2) 不动点传播 dead：节点所有入边都未激活（或来自 dead）→ 该节点 dead，其出边也变未激活
      const dead = new Set();
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of graph.nodes.values()) {
          if (done.has(n.id) || dead.has(n.id)) continue;
          const parents = graph.parents[n.id] ?? [];
          if (!parents.length) continue; // 根节点（无入边）永不 dead
          const allInactive = parents.every((p) => dead.has(p) || inactive.has(`${p}>${n.id}`));
          if (allInactive) {
            dead.add(n.id);
            changed = true;
            for (const e of spec.edges ?? []) if (e.from === n.id) inactive.add(edgeKey(e));
          }
        }
      }
      // 3) dead 节点记为 done(skipped)
      for (const id of dead) {
        done.add(id);
        skipped.add(id);
        nodeOutputs[id] = { skipped: true };
        await record({ execId, nodeId: id, status: "skipped", output: { skipped: true } });
        await log(execId, `⏭ 节点 ${id} 因上游条件分支未命中被跳过`);
      }
    }

    // 所有节点均已完成任务：标记执行整体完成，并更新流水线的运行状态为 completed
    // 全量快照：必须携带 trigger_raw/node_outputs/loops/skipped，否则下一轮（含 drain 循环、
    // 测试回传）会丢条件上下文与迭代状态——这是 branch/loop 语义成立的关键。
    const fullSnap = () => ({
      done: [...done], waiting, environment: toFlat(),
      trigger_raw: snap.trigger_raw, node_outputs: nodeOutputs,
      loops, skipped: [...skipped],
    });
    if (done.size === graph.nodes.size && !waiting) {
      await snapshot(execId, { ...fullSnap(), status: "completed" });
      console.log(`[advance] exec=${execId} ✅ 全部 ${graph.nodes.size} 个节点已完成 → 执行标记为 completed，更新流水线运行状态`);
      await complete({ execId, status: "completed" });
      return { spec, snap: { ...fullSnap(), status: "completed" }, waiting: null };
    }

    await snapshot(execId, fullSnap());
    return { spec, snap: fullSnap(), waiting };
  }

  return { advanceOnce };
}