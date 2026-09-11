import test from "node:test";
import assert from "node:assert/strict";
import { computeLayers, layoutDag } from "./dagLayout.js";

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
