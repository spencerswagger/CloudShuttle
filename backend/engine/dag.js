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