// hook 分发与续跑编排：回调已到 → 标记节点终态 + 再推进
// 依赖注入：loadSpec(读 spec 并携带 execId，作为 loadSpecForExec 的默认实现)
//           loadSpecForExec(按 execId 读 spec) / snapshotStore(快照读写)
//           advance(一次推进) / record(写节点记录)。
// 触发（手动/webhook）不在本层装配 spec：由控制面 hydrateForRun 造好携带 execId 的
// spec 与 environment 后直接调用 run，故本层不保留任何独立的 webhook 触发入口（历史死代码已删）。
import { parseOutput } from "./variables.js";
import { normalizeWaiting } from "./state.js";

// 回调续跑互斥锁的 key：多 ECI 容器并发回调 / 审批回调到达时，必须串行化
// 「读快照 → markDone → save → record → advance」整段，否则两个回调同时续跑会造成
// 推进重复/快照 lost-update（Task 2 曾用「每轮只派发一个」规避，本任务放开多派发后改由锁保证）。
const LOCK_KEY = "exec-callback";
const LOCK_TTL_SEC = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createOrchestrator({
  loadSpec,
  loadSpecForExec = loadSpec,
  snapshotStore,
  advance,
  record,
  schedLog = async () => {},
  // 把 exec 落为失败终态（更新 execution 表）；拒绝/失败回调等场景使用，
  // 否则 execution.status 会一直停留在 running（issue：审批不通过仍显示运行中）
  failExecution = async () => {},
  // 回调续跑互斥锁。默认空实现：未注入时 acquire 恒成功（向后兼容、单测可离线）；
  // 生产由 index.js 注入 redis 分布式锁（engine/mutex.js），与 state.js 用同一把 key。
  mutex = { acquire: async () => true, release: async () => {} },
}) {
  // 串行化执行临界区：拿到锁才进入，finally 必定 release。
  // redis NX 锁的 acquire 不阻塞（拿不到立即返回 false），此处拿不到时短暂轮询重试；
  // 本地队列锁（单测）的 acquire 本身会排队等待，await 后即持有，不触发轮询。
  async function withExclusive(fn) {
    for (;;) {
      const ok = await mutex.acquire(LOCK_KEY, LOCK_TTL_SEC);
      if (ok) break;
      await sleep(10);
    }
    try {
      return await fn();
    } finally {
      await mutex.release(LOCK_KEY);
    }
  }

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
    // 与回调同锁串行化：避免「清快照 → 推进」与同 execId 的迟到回调交错。
    return withExclusive(async () => {
      await snapshotStore.clear(spec.execId);
      await schedLog(spec.execId, "▶ 执行启动：清除旧快照，开始推进节点");
      console.log(`[run] exec=${spec.execId} 启动/续跑执行：已清除同 id 旧快照，开始推进节点`);
      const stored = (await snapshotStore.load(spec.execId)) ?? {};
      // 恢复快照 environment（扁平对象）为基础值，再叠写外部显式传入的 environment（同名覆盖优先）
      const env = buildEnv(stored.environment, environment);
      const snap = { ...stored, environment: stored.environment ?? {} };
      return advance({ spec, snap, execId: spec.execId, environment: env });
    });
  }

  // 把某节点标记为终态、从 waiting 集合移除（只移除自己的 nodeId，不误清其他等待节点），写快照（供续跑）
  async function markDone(nodeId, execId, failed) {
    const snap = (await snapshotStore.load(execId)) ?? {};
    const done = new Set(snap.done ?? []);
    done.add(nodeId);
    // waiting 集合化：仅移除本次回调对应的 nodeId；其余仍等待的节点保留（多 ECI 各自回调各自清）
    const waiting = normalizeWaiting(snap.waiting);
    const rest = waiting ? waiting.filter((id) => id !== nodeId) : null;
    const next = { done: [...done], waiting: rest?.length ? rest : null };
    // 透传快照 environment，确保续跑写回不丢变量地图
    if (snap.environment) next.environment = snap.environment;
    if (failed) next.status = "failed";
    await snapshotStore.save(execId, next);
    await schedLog(execId, `节点 ${nodeId} 标记为${failed ? "失败" : "成功"}终态（已结束 ${done.size} 个节点）`);
    console.log(
      `[markDone] exec=${execId} 节点 ${nodeId} 标记为${failed ? "失败" : "成功"}终态，` +
      `已结束 ${done.size} 节点，剩余等待=${JSON.stringify(next.waiting)}，执行状态=${failed ? "failed" : snap.status ?? "running"}`
    );
    return next;
  }

  return {
    run,
    // ECI 结束回调：节点成功 → 解析 K=V 输出写回 environment → 载入 spec 续跑到下一节点
    // 整段（读快照→markDone→save→record→advance）在 mutex 内串行化：多 ECI 并发回调到达时
    // 只允许一个续跑，防推进重复/快照 lost-update；waiting 只移除自己的 nodeId。
    async onEciDone({ execId, nodeId, output, logs }) {
      return withExclusive(async () => {
        console.log(`[orchestrator] exec=${execId} 收到 ECI 节点 ${nodeId} 成功回调，解析输出并继续推进`);
        const parsed = parseOutput(output);
        const next = await markDone(nodeId, execId, false);
        await record({ execId, nodeId, status: "succeeded", output: parsed, logs });
        const spec = await loadSpecForExec(execId);
        // 把解析出的 K=V 写回 environment（对后继节点可见），再向后继 advance
        const env = buildEnv(next.environment, parsed);
        return advance({ spec, snap: next, execId, environment: env });
      });
    },
    // ECI 失败回调 → 该节点终态失败，整个执行结束
    async onEciFail({ execId, nodeId }) {
      return withExclusive(async () => {
        console.log(`[orchestrator] exec=${execId} 收到 ECI 节点 ${nodeId} 失败回调 → 执行标记为 failed`);
        const next = await markDone(nodeId, execId, true);
        await record({ execId, nodeId, status: "failed", output: { kind: "eci", status: "failed" } });
        await schedLog(execId, `✗ 收到 ECI 失败回调（节点 ${nodeId}），执行标记为失败`);
        await failExecution(execId);
        return { status: "failed", done: next.done };
      });
    },
    // 钉钉审批回调：approve 续跑；reject 终止该执行
    async onApproval({ execId, nodeId, decision }) {
      return withExclusive(async () => {
        if (decision === "reject") {
          console.log(`[orchestrator] exec=${execId} 审批节点 ${nodeId} 被拒绝 → 执行标记为 failed（拒绝即失败）`);
          const next = await markDone(nodeId, execId, true);
          await record({ execId, nodeId, status: "rejected", output: { decision: "reject" } });
          await schedLog(execId, `✗ 审批被拒绝（节点 ${nodeId}），执行标记为失败`);
          await failExecution(execId);
          return { status: "failed", done: next.done };
        }
        console.log(`[orchestrator] exec=${execId} 审批节点 ${nodeId} 已通过 → 标记完成并继续推进下一个节点`);
        const next = await markDone(nodeId, execId, false);
        await record({ execId, nodeId, status: "succeeded", output: { decision: "approve" } });
        await schedLog(execId, `✆ 审批通过（节点 ${nodeId}），继续推进后续节点`);
        const spec = await loadSpecForExec(execId);
        // 续跑不丢 environment：从 markDone 透传回的快照 environment 重建 Map，供 state.advanceOnce 继续引用
        return advance({ spec, snap: next, execId, environment: buildEnv(next.environment, null) });
      });
    },
  };
}