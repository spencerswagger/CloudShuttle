import test from "node:test";
import assert from "node:assert/strict";
import { makeLoopStep } from "./loop.js";

test("loop step 返回 done 且输出为空（迭代推进由引擎状态机完成）", async () => {
  const step = makeLoopStep();
  const res = await step({ id: "l1", type: "loop", params: { items: { count: 3 } } }, { environment: new Map() });
  assert.deepEqual(res, { kind: "done", output: {} });
});

test("loop step 与节点参数无关（no-op 标记节点）", async () => {
  const step = makeLoopStep();
  const res = await step({ id: "l2", type: "loop", params: {} }, { environment: new Map() });
  assert.equal(res.kind, "done");
  assert.deepEqual(res.output, {});
});
