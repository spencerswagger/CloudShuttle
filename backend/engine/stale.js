// backend/engine/stale.js —— Shell(k8s Job) 挂起兜底：等待回调的节点超时未回调 → 判定 stale
// FC 无定时器，控制面在 push 入口（列表/运行/续跑）惰性清理：把长时间无回调的派发节点终止为失败。
// 纯函数便于单测；真实 since 由调用方注入（当前用 webhook_registry.expires_at - 24h 反推派发时刻）。

/**
 * 扫描 waiting 中已超时的节点（timeout 秒 + 缓冲 60s 仍未收到回调）。
 * @param {string[]|null} waiting 快照 waiting 节点 id 数组
 * @param {(nodeId:string)=>number|undefined} sinceOf 节点派发时间戳（ms）
 * @param {(nodeId:string)=>number} timeoutOf 节点超时秒数（默认 300）
 * @param {number} now 当前时间戳（ms）
 * @returns {string[]} 超时节点 id（可空数组）
 */
export function staleWaiting(waiting, sinceOf, timeoutOf, now) {
  const list = Array.isArray(waiting) ? waiting : [];
  const out = [];
  for (const id of list) {
    const since = sinceOf(id);
    if (since == null || !Number.isFinite(since)) continue; // 无派发记录（历史数据）不误判
    const timeoutSec = Number(timeoutOf(id)) > 0 ? Number(timeoutOf(id)) : 300;
    if (now - since > (timeoutSec + 60) * 1000) out.push(id);
  }
  return out;
}