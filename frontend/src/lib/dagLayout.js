// 拓扑分层：层 = 0 起步；节点层 = max(所有前驱层) + 1；环用已访问集防死循环。
export function computeLayers(nodes, edges, visited = new Set()) {
  const parents = {};
  for (const n of nodes) parents[n.id] = [];
  for (const e of edges) parents[e.to] = [...(parents[e.to] ?? []), e.from];
  const layer = {};
  function depth(id) {
    if (layer[id] != null) return layer[id];
    if (visited.has(id)) return 0; // 环保护
    visited.add(id);
    const ps = parents[id] ?? [];
    layer[id] = ps.length ? Math.max(...ps.map(depth)) + 1 : 0;
    return layer[id];
  }
  for (const n of nodes) depth(n.id);
  return layer;
}

// 按层在本层横排布点，返回 [{id,x,y}]。gap 由调用方传入节点宽高与间距。
export function layoutDag(nodes, edges, { w = 180, h = 40, gapX = 40, gapY = 70 } = {}) {
  const layer = computeLayers(nodes, edges);
  const byLayer = {};
  for (const n of nodes) (byLayer[layer[n.id]] ??= []).push(n);
  const out = [];
  for (const lvl of Object.keys(byLayer).map(Number).sort((a, b) => a - b)) {
    const group = byLayer[lvl];
    const totalW = group.length * w + (group.length - 1) * gapX;
    group.forEach((n, i) => {
      out.push({ id: n.id, x: i * (w + gapX), y: lvl * (h + gapY), layer: lvl });
    });
  }
  return out;
}
