// hook 分发与续跑编排：回调已到 → 标记节点终态 + 再推进
// 依赖注入：loadSpec(读 spec 并携带 execId) / loadSpecForExec(按 execId 读 spec)
//           snapshotStore(快照读写) / advance(一次推进) / record(写节点记录)。
export function createOrchestrator({
  loadSpec,
  loadSpecForExec = loadSpec,
  snapshotStore,
  advance,
  record,
}) {
  async function run(spec) {
    // 新执行必须从空快照启动：openExecution 新造的自增 id 可能因 bootstrap 重跑
    // 序列而被复用，redis 里同 id 残留的 snap 快照（7 天 TTL 不清）会被误读成旧 waiting，
    // 导致全新运行 BLOCKED-BY-WAIT。故每次新运行先清一次，保证各执行完全独立。
    await snapshotStore.clear(spec.execId);
    const snap = (await snapshotStore.load(spec.execId)) ?? {};
    return advance({ spec, snap, execId: spec.execId });
  }

  // 把某节点标记为终态、清空 waiting，写快照（供续跑）
  async function markDone(nodeId, execId, failed) {
    const snap = (await snapshotStore.load(execId)) ?? {};
    const done = new Set(snap.done ?? []);
    done.add(nodeId);
    const next = { done: [...done], waiting: null };
    if (failed) next.status = "failed";
    await snapshotStore.save(execId, next);
    return next;
  }

  return {
    // git webhook：loadSpec 得到携带 execId 的 spec，载入快照后推进；
    // authority 来自请求 Host，写入 spec 供回调拼绝对地址
    async onGitWebhook({ pipelineId, trigger, authority }) {
      const spec = await loadSpec(pipelineId, trigger, authority ? { authority } : undefined);
      return run(spec);
    },
    // ECI 结束回调：节点成功 → 载入 spec 续跑到下一节点
    async onEciDone({ execId, nodeId }) {
      const next = await markDone(nodeId, execId, false);
      await record({ execId, nodeId, status: "succeeded", output: { kind: "eci" } });
      const spec = await loadSpecForExec(execId);
      return advance({ spec, snap: next, execId });
    },
    // ECI 失败回调 → 该节点终态失败，整个执行结束
    async onEciFail({ execId, nodeId }) {
      const next = await markDone(nodeId, execId, true);
      await record({ execId, nodeId, status: "failed", output: { kind: "eci", status: "failed" } });
      return { status: "failed", done: next.done };
    },
    // 钉钉审批回调：approve 续跑；reject 终止该执行
    async onApproval({ execId, nodeId, decision }) {
      if (decision === "reject") {
        const next = await markDone(nodeId, execId, true);
        await record({ execId, nodeId, status: "rejected", output: { decision: "reject" } });
        return { status: "failed", done: next.done };
      }
      const next = await markDone(nodeId, execId, false);
      await record({ execId, nodeId, status: "succeeded", output: { decision: "approve" } });
      const spec = await loadSpecForExec(execId);
      return advance({ spec, snap: next, execId });
    },
  };
}