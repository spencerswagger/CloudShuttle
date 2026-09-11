import test from "node:test";
import assert from "node:assert/strict";
import { computeLayers, layoutDag, wouldCycle } from "./dagLayout.js";

test("computeLayers 按 edges 分层（无依赖=0，后继=前驱最大层+1）", () => {
  const layers = computeLayers(
    [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
    [{ from: "a", to: "c" }, { from: "b", to: "c" }, { from: "c", to: "d" }],
  );
  assert.equal(layers["a"], 0);
  assert.equal(layers["b"], 0);
  assert.equal(layers["c"], 1);
  assert.equal(layers["d"], 2);
});

test("layoutDag 输出每个节点的 {x,y} 且同层不重叠", () => {
  const laid = layoutDag(
    [{ id: "a" }, { id: "b" }, { id: "c" }],
    [{ from: "a", to: "c" }, { from: "b", to: "c" }],
    { w: 180, h: 40, gapX: 40, gapY: 70 },
  );
  const a = laid.find((n) => n.id === "a");
  const b = laid.find((n) => n.id === "b");
  const c = laid.find((n) => n.id === "c");
  assert.ok(a.y === b.y, "同层同一 y 行");
  assert.ok(Math.abs(a.x - b.x) >= 180, "同层 x 分隔开");
  assert.ok(c.y > a.y, "后继层 y 增大");
});

test("wouldCycle 判环：自环/直接反向/间接反向都拦截，合法边放行", () => {
  const edges = [
    { from: "a", to: "c" },
    { from: "b", to: "c" },
    { from: "c", to: "d" },
  ];
  // 自环
  assert.equal(wouldCycle(edges, "a", "a"), true, "自环应拦截");
  // 直接反向（新增 d→c：既有 c→d，使 c→d→c 成环）
  assert.equal(wouldCycle(edges, "d", "c"), true, "直接反向应拦截");
  // 间接反向（新增 c→a：a 已是 c 的祖先）
  assert.equal(wouldCycle(edges, "c", "a"), true, "间接反向应拦截");
  // 合法新增边（a→b：b 无法到达 a）
  assert.equal(wouldCycle(edges, "a", "b"), false, "合法边应放行");
  // 合法新增边（a→d：d 是汇点，无路径回到 a）
  assert.equal(wouldCycle(edges, "a", "d"), false, "无环合法边应放行");
});
