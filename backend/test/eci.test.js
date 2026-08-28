import { test } from "node:test";
import assert from "node:assert/strict";
import { makeShellStep } from "../steps/shell.js";

test("shell step 派发 ECI 并登记回调", async () => {
  let dispatched = null;
  const eciProvider = {
    dispatch: async (arg) => { dispatched = arg; return { jobRef: "job-1" }; },
  };
  const registry = [];
  const step = makeShellStep({
    eciProvider,
    genToken: () => "tok-1",
    controlPlaneBase: "https://cp.example.com",
  });
  const node = { id: "n1", type: "shell", params: { image: "alpine", command: "echo hi" } };
  const ctx = { execId: 11, recordRegistry: async (r) => registry.push(r) };
  const out = await step(node, ctx);
  assert.equal(out.kind, "dispatch");
  assert.equal(out.ref, "job-1");
  assert.equal(dispatched.execId, 11);
  assert.equal(dispatched.nodeId, "n1");
  assert.equal(dispatched.image, "alpine");
  assert.equal(dispatched.command, "echo hi");
  assert.equal(dispatched.callbackUrl, "https://cp.example.com/_/hook/ecidone/11?token=tok-1&secret=tok-1");
  assert.equal(dispatched.token, "tok-1");
  assert.equal(registry[0].kind, "eci");
  assert.equal(registry[0].token, "tok-1");
  assert.equal(registry[0].secret, "tok-1");
  assert.equal(registry[0].execId, 11);
  assert.equal(registry[0].nodeId, "n1");
});