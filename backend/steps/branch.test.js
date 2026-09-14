import test from "node:test";
import assert from "node:assert/strict";
import { makeBranchStep } from "./branch.js";

test("branch step 返回 done 且输出为空（边条件求值由引擎推进层完成）", async () => {
  const step = makeBranchStep();
  const res = await step({ id: "b1", type: "branch", params: {} }, { environment: new Map() });
  assert.deepEqual(res, { kind: "done", output: {} });
});

test("branch step 与节点参数无关（no-op 标记节点）", async () => {
  const step = makeBranchStep();
  const res = await step({ id: "b2", type: "branch", params: { anything: 1 } }, { environment: new Map() });
  assert.equal(res.kind, "done");
  assert.deepEqual(res.output, {});
});
