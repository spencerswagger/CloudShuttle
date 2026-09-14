// DAG 构建 / 推进 / 校验。conditions.js 提供边条件 op 白名单（COND_OPS），
// 仅依赖 jsonpath-plus，不构成循环依赖。
import { COND_OPS } from "./conditions.js";

export function buildGraph(spec) {
  const nodes = new Map((spec.nodes ?? []).map((n) => [n.id, n]));
  const successors = {};
  const parents = {};
  for (const n of nodes.keys()) { successors[n] = []; parents[n] = []; }
  for (const e of spec.edges ?? []) {
    successors[e.from].push(e.to);
    parents[e.to].push(e.from);
  }
  return { nodes, successors, parents };
}

export function nextReady(graph, doneIds) {
  const ready = [];
  for (const id in graph.parents) {
    if (doneIds.has(id)) continue;
    if (graph.parents[id].every((p) => doneIds.has(p))) ready.push(id);
  }
  return ready;
}

/**
 * 返回某节点的所有祖先节点 id 的 Set（含间接前驱，不含自身）。
 * visited 用于环保护（有向环时避免死循环）；默认空集。
 * @param {{parents: Record<string,string[]>}} graph
 * @param {string} nodeId
 * @param {Set<string>} [visited]
 * @returns {Set<string>}
 */
export function ancestors(graph, nodeId, visited = new Set()) {
  const result = new Set();
  const stack = [...(graph.parents[nodeId] ?? [])];
  while (stack.length) {
    const id = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    result.add(id);
    for (const p of graph.parents[id] ?? []) stack.push(p);
  }
  return result;
}

// 返回 { ok, errors[] }。校验：节点 id 唯一、边端点存在、有向无环（DFS 三色法）。
export function validateSpec(spec) {
  const errors = [];
  const nodes = spec?.nodes ?? [];
  const edges = spec?.edges ?? [];
  const ids = new Set();
  const dup = new Set();
  for (const n of nodes) {
    if (ids.has(n.id)) dup.add(n.id);
    ids.add(n.id);
  }
  for (const id of dup) errors.push(`存在重复节点 id: ${id}`);
  const children = {};
  for (const id of ids) { children[id] = []; }
  for (const e of edges) {
    if (!ids.has(e.from)) { errors.push(`边的起点不存在: ${e.from}`); continue; }
    if (!ids.has(e.to)) { errors.push(`边的终点不存在: ${e.to}`); continue; }
    children[e.from].push(e.to);
  }
  // 边条件格式（branch 出边 cond）
  for (const e of edges) {
    if (!e.cond) continue;
    if (typeof e.cond.path !== "string" || !e.cond.path.trim()) {
      errors.push(`边 ${e.from}→${e.to} 条件缺少 path`);
    } else if (!COND_OPS.includes(e.cond.op)) {
      errors.push(`边 ${e.from}→${e.to} 条件 op 非法: ${e.cond.op}`);
    }
  }
  // loop 区域约束
  for (const n of nodes) {
    if (n.type !== "loop") continue;
    const { err } = loopRegionOf({ nodes, edges, loopId: n.id });
    if (err) errors.push(err);
  }
  // DFS 三色法判环：0=未访问 1=访问中 2=已结束
  const color = {};
  for (const id of ids) color[id] = 0;
  let cycle = false;
  function dfs(id) {
    color[id] = 1;
    for (const c of children[id] ?? []) {
      if (color[c] === 1) { cycle = true; return; }
      if (color[c] === 0) dfs(c);
    }
    color[id] = 2;
  }
  for (const id of ids) if (color[id] === 0) dfs(id);
  if (cycle) errors.push("检测到环（cycle），DAG 不允许环存在");
  return { ok: errors.length === 0, errors };
}

// 计算 loop 循环区域：loopId → { bodyIds, joinId }（或 { err }）。
// 区域 = loop 可达、首个 join 之前的全部节点；仅支持单一收敛 join。
// 循环体内不允许 trigger/branch/join/loop（仅普通节点）。
export function loopRegionOf({ nodes, edges, loopId }) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const succ = {}; const pred = {};
  for (const n of nodes) { succ[n.id] = []; pred[n.id] = []; }
  for (const e of edges) { succ[e.from].push(e.to); pred[e.to].push(e.from); }
  const seen = new Set();
  const joins = [];
  const stack = [...(succ[loopId] ?? [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    if (byId.get(id)?.type === "join") { joins.push(id); continue; } // 不穿过 join
    for (const c of succ[id] ?? []) stack.push(c);
  }
  if (joins.length === 0) return { err: `loop 节点 ${loopId} 缺少收敛的 join 节点` };
  if (joins.length > 1) return { err: `loop 节点 ${loopId} 区域存在多个 join 节点（${joins.join(",")}），仅支持单一收敛` };
  const joinId = joins[0];
  const bodyIds = [...seen].filter((id) => id !== joinId);
  if (!bodyIds.length) return { err: `loop 节点 ${loopId} 出边不能直连 join，循环体至少 1 个节点` };
  const FORBIDDEN = new Set(["trigger", "branch", "join", "loop"]);
  for (const id of bodyIds) {
    const t = byId.get(id)?.type;
    if (FORBIDDEN.has(t)) return { err: `loop 节点 ${loopId} 循环体内不允许 ${t} 节点（${id}）` };
  }
  for (const p of pred[joinId] ?? []) {
    if (!bodyIds.includes(p)) return { err: `join 节点 ${joinId} 的入边来自循环体外节点 ${p}` };
  }
  for (const c of succ[loopId] ?? []) {
    if (!bodyIds.includes(c)) return { err: `loop 节点 ${loopId} 的出边指向循环体外节点 ${c}` };
  }
  for (const id of bodyIds) {
    for (const c of succ[id] ?? []) {
      if (c !== joinId && !bodyIds.includes(c)) return { err: `loop 节点 ${loopId} 循环体节点 ${id} 的出边离开循环区域（${c}）` };
    }
  }
  return { bodyIds, joinId };
}
