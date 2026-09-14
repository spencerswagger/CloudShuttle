import test from "node:test";
import assert from "node:assert/strict";
import { makeTriggerStep } from "./trigger.js";

test("trigger step 返回 done 且输出为空（触发变量已由 hydrateForRun 注入 environment）", async () => {
  const step = makeTriggerStep();
  const node = { id: "t1", type: "trigger", kind: "manual", params: {} };
  const res = await step(node, { environment: new Map([["foo", "1"]]) });
  assert.deepEqual(res, { kind: "done", output: {} });
});

test("trigger step 与节点 kind 无关（manual/webhook 同属 no-op）", async () => {
  const step = makeTriggerStep();
  const web = await step({ id: "t2", type: "trigger", kind: "webhook", params: {} }, { environment: new Map() });
  assert.equal(web.kind, "done");
  assert.deepEqual(web.output, {});
});