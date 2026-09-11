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
  const parents = {};
  const children = {};
  for (const id of ids) { parents[id] = []; children[id] = []; }
  for (const e of edges) {
    if (!ids.has(e.from)) { errors.push(`边的起点不存在: ${e.from}`); continue; }
    if (!ids.has(e.to)) { errors.push(`边的终点不存在: ${e.to}`); continue; }
    parents[e.to].push(e.from);
    children[e.from].push(e.to);
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