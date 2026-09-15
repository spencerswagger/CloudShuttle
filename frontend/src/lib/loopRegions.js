// 循环区域计算（与后端 engine/dag.js 的 loopRegionOf 同规则）：
// 区域 = loop 节点可达、首个 join 之前的全部节点；仅当存在唯一收敛 join 时返回区域。
// 编辑画布 / 执行详情拓扑的「循环体」容器绘制共用；非法区域（无 join/多 join/空体）不返回。
export function loopRegions(spec) {
  const nodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
  const edges = Array.isArray(spec?.edges) ? spec.edges : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const succ = {};
  for (const n of nodes) succ[n.id] = [];
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue; // 悬挂边忽略
    succ[e.from].push(e.to);
  }
  const regions = [];
  for (const ln of nodes.filter((n) => n.type === "loop")) {
    const seen = new Set();
    const joins = [];
    const stack = [...(succ[ln.id] ?? [])];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      if (byId.get(id)?.type === "join") { joins.push(id); continue; } // 不穿过 join
      for (const c of succ[id] ?? []) stack.push(c);
    }
    if (joins.length !== 1) continue;
    const joinId = joins[0];
    const bodyIds = [...seen].filter((id) => id !== joinId);
    if (!bodyIds.length) continue;
    regions.push({ loopId: ln.id, joinId, bodyIds });
  }
  return regions;
}