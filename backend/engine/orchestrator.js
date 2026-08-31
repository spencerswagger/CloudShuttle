// hook 分发与续跑编排：回调已到 → 标记节点终态 + 再推进
// 依赖注入：loadSpec(读 spec 并携带 execId，作为 loadSpecForExec 的默认实现)
//           loadSpecForExec(按 execId 读 spec) / snapshotStore(快照读写)
//           advance(一次推进) / record(写节点记录)。
// 触发（手动/webhook）不在本层装配 spec：由控制面 hydrateForRun 造好携带 execId 的
// spec 与 environment 后直接调用 run，故本层不保留任何独立的 webhook 触发入口（历史死代码已删）。
import { parseOutput } from "./variables.js";

export function createOrchestrator({
  loadSpec,
  loadSpecForExec = loadSpec,
  snapshotStore,
  advance,
  record,
}) {
  // 把扁平环境源（快照 environment 对象 + 可选外部 Map/对象）构造成内部 Map，值统一转字符串。
  // 语义与 state.js 保持一致：快照环境作基础值，外部显式传入的同名变量覆盖优先。
  function buildEnv(snapEnv, extra) {
    const env = new Map();
    if (snapEnv && typeof snapEnv === "object" && !(snapEnv instanceof Map)) {
      for (const [k, v] of Object.entries(snapEnv)) env.set(k, String(v));
    }
    if (extra instanceof Map) {
      for (const [k, v] of extra) env.set(k, String(v));
    } else if (extra && typeof extra === "object") {
      for (const [k, v] of Object.entries(extra)) env.set(k, String(v));
    }
    return env;
  }

  async function run(spec, environment) {
    // 新执行必须从空快照启动：openExecution 新造的自增 id 可能因 bootstrap 重跑
    // 序列而被复用，redis 里同 id 残留的 snap 快照（7 天 TTL 不清）会被误读成旧 waiting，
    // 导致全新运行 BLOCKED-BY-WAIT。故每次新运行先清一次，保证各执行完全独立。
    await snapshotStore.clear(spec.execId);
    console.log(`[run] exec=${spec.execId} 启动/续跑执行：已清除同 id 旧快照，开始推进节点`);
    const stored = (await snapshotStore.load(spec.execId)) ?? {};
    // 恢复快照 environment（扁平对象）为基础值，再叠写外部显式传入的 environment（同名覆盖优先）
    const env = buildEnv(stored.environment, environment);
    const snap = { ...stored, environment: stored.environment ?? {} };
    return advance({ spec, snap, execId: spec.execId, environment: env });
  }

  // 把某节点标记为终态、清空 waiting，写快照（供续跑）
  async function markDone(nodeId, execId, failed) {
    const snap = (await snapshotStore.load(execId)) ?? {};
    const done = new Set(snap.done ?? []);
    done.add(nodeId);
    const next = { done: [...done], waiting: null };
    // 透传快照 environment，确保续跑写回不丢变量地图
    if (snap.environment) next.environment = snap.environment;
    if (failed) next.status = "failed";
    await snapshotStore.save(execId, next);
    console.log(
      `[markDone] exec=${execId} 节点 ${nodeId} 标记为${failed ? "失败" : "成功"}终态，` +
      `已结束 ${done.size} 节点，执行状态=${failed ? "failed" : snap.status ?? "running"}`
    );
    return next;
  }

  return {
    run,
    // ECI 结束回调：节点成功 → 解析 K=V 输出写回 environment → 载入 spec 续跑到下一节点
    async onEciDone({ execId, nodeId, output, logs }) {
      console.log(`[orchestrator] exec=${execId} 收到 ECI 节点 ${nodeId} 成功回调，解析输出并继续推进`);
      const parsed = parseOutput(output);
      const next = await markDone(nodeId, execId, false);
      await record({ execId, nodeId, status: "succeeded", output: parsed, logs });
      const spec = await loadSpecForExec(execId);
      // 把解析出的 K=V 写回 environment（对后继节点可见），再向后继 advance
      const env = buildEnv(next.environment, parsed);
      return advance({ spec, snap: next, execId, environment: env });
    },
    // ECI 失败回调 → 该节点终态失败，整个执行结束
    async onEciFail({ execId, nodeId }) {
      console.log(`[orchestrator] exec=${execId} 收到 ECI 节点 ${nodeId} 失败回调 → 执行标记为 failed`);
      const next = await markDone(nodeId, execId, true);
      await record({ execId, nodeId, status: "failed", output: { kind: "eci", status: "failed" } });
      return { status: "failed", done: next.done };
    },
    // 钉钉审批回调：approve 续跑；reject 终止该执行
    async onApproval({ execId, nodeId, decision }) {
      if (decision === "reject") {
        console.log(`[orchestrator] exec=${execId} 审批节点 ${nodeId} 被拒绝 → 执行标记为 failed（拒绝即失败）`);
        const next = await markDone(nodeId, execId, true);
        await record({ execId, nodeId, status: "rejected", output: { decision: "reject" } });
        return { status: "failed", done: next.done };
      }
      console.log(`[orchestrator] exec=${execId} 审批节点 ${nodeId} 已通过 → 标记完成并继续推进下一个节点`);
      const next = await markDone(nodeId, execId, false);
      await record({ execId, nodeId, status: "succeeded", output: { decision: "approve" } });
      const spec = await loadSpecForExec(execId);
      // 续跑不丢 environment：从 markDone 透传回的快照 environment 重建 Map，供 state.advanceOnce 继续引用
      return advance({ spec, snap: next, execId, environment: buildEnv(next.environment, null) });
    },
  };
}