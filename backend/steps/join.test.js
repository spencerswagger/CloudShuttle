import test from "node:test";
import assert from "node:assert/strict";
import { makeJoinStep } from "./join.js";

test("join step 返回 done 且输出为空（汇聚由 DAG 依赖自然收敛）", async () => {
  const step = makeJoinStep();
  const res = await step({ id: "j1", type: "join", params: {} }, { environment: new Map() });
  assert.deepEqual(res, { kind: "done", output: {} });
});

test("join step 与节点参数无关（no-op 标记节点）", async () => {
  const step = makeJoinStep();
  const res = await step({ id: "j2", type: "join", params: { anything: 1 } }, { environment: new Map() });
  assert.equal(res.kind, "done");
  assert.deepEqual(res.output, {});
});
