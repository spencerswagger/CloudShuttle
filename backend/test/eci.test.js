import { test } from "node:test";
import assert from "node:assert/strict";
import { makeShellStep } from "../steps/shell.js";

test("shell step 派发 ECI：注入 job URL / 输出文件 / 回调 token+secret / 控制面基址", async () => {
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
  const asMap = Object.fromEntries(dispatched.env.map((e) => [e.k, e.v]));
  assert.equal(asMap.CLOUDSHUTTLE_JOB_URL, "https://cp.example.com/_/hook/job/tok-1");
  assert.equal(asMap.CLOUDSHUTTLE_OUT_FILE, "/tmp/out");
  assert.equal(asMap.CLOUDSHUTTLE_TOKEN, "tok-1");
  assert.equal(asMap.CLOUDSHUTTLE_CB_SECRET, "tok-1");
  assert.equal(asMap.CLOUDSHUTTLE_CB_BASE, "https://cp.example.com");
  assert.equal(asMap.CLOUDSHUTTLE_EXEC_ID, "11");
  assert.equal(asMap.CLOUDSHUTTLE_NODE_ID, "n1");
  assert.equal(dispatched.callbackUrl, "https://cp.example.com/_/hook/ecidone/11?token=tok-1&secret=tok-1");
  assert.equal(dispatched.execId, 11);
  assert.equal(dispatched.nodeId, "n1");
  assert.equal(dispatched.image, "alpine");
  assert.equal(dispatched.command, "echo hi");
  assert.equal(dispatched.token, "tok-1");
  assert.equal(registry[0].kind, "eci");
  assert.equal(registry[0].token, "tok-1");
  assert.equal(registry[0].secret, "tok-1");
  assert.equal(registry[0].execId, 11);
  assert.equal(registry[0].nodeId, "n1");
});