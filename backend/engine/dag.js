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