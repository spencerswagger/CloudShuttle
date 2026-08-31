import { test } from "node:test";
import assert from "node:assert/strict";
import { makeShellStep, outputKeysOf } from "./shell.js";

// runner 引导变量：固定在 env 最前，environment/p.env 不得覆盖该契约。
function controlEnv({ base, token, execId, nodeId }) {
  return [
    { k: "CLOUDSHUTTLE_JOB_URL", v: `${base}/_/hook/job/${token}` },
    { k: "CLOUDSHUTTLE_OUT_FILE", v: "/tmp/out" },
    { k: "CLOUDSHUTTLE_TOKEN", v: token },
    { k: "CLOUDSHUTTLE_CB_SECRET", v: token },
    { k: "CLOUDSHUTTLE_CB_BASE", v: base },
    { k: "CLOUDSHUTTLE_EXEC_ID", v: String(execId) },
    { k: "CLOUDSHUTTLE_NODE_ID", v: nodeId },
  ];
}

test("outputKeysOf：无显式 outputs 时给默认单 key step_out", () => {
  assert.deepEqual(outputKeysOf({ image: "alpine" }), ["step_out"]);
  assert.deepEqual(outputKeysOf({}), ["step_out"]);
  assert.deepEqual(outputKeysOf(undefined), ["step_out"]);
});

test("outputKeysOf：优先取用户显式声明的 p.outputs[].key（按声明顺序）", () => {
  const p = { outputs: [{ key: "build_id" }, { key: "url" }, { key: "" }] };
  assert.deepEqual(outputKeysOf(p), ["build_id", "url"]);
});

test("shell step：environment 扁平变量追加进 env 数组（节点 p.env 在前，environment 在后）", async () => {
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
  const node = {
    id: "n1", type: "shell",
    params: { image: "alpine", command: "echo hi", env: [{ k: "A", v: "1" }] },
  };
  const environment = new Map();
  environment.set("pipeline_name", "demo");
  environment.set("run_no", "7");
  const ctx = { execId: 11, environment, recordRegistry: async (r) => registry.push(r) };
  const out = await step(node, ctx);
  assert.equal(out.kind, "dispatch");
  assert.equal(out.ref, "job-1");
  assert.deepEqual(out.outputKeys, ["step_out"], "应声明默认输出 key");
  // env 顺序：引导变量 + 节点自身 A 在前，environment 的 pipeline_name/run_no 在后
  assert.deepEqual(dispatched.env, [
    ...controlEnv({ base: "https://cp.example.com", token: "tok-1", execId: 11, nodeId: "n1" }),
    { k: "A", v: "1" },
    { k: "pipeline_name", v: "demo" },
    { k: "run_no", v: "7" },
  ]);
});

test("shell step：environment 为普通对象时同样铺平成 {k,v}", async () => {
  let dispatched = null;
  const eciProvider = { dispatch: async (arg) => { dispatched = arg; return { jobRef: "j" }; } };
  const step = makeShellStep({
    eciProvider, genToken: () => "t", controlPlaneBase: "https://cp",
  });
  const node = { id: "n", type: "shell", params: { image: "i", command: "c" } };
  const out = await step(node, {
    execId: 1,
    environment: { foo: "bar", num: 5 },
    recordRegistry: async () => {},
  });
  assert.equal(out.outputKeys[0], "step_out");
  assert.deepEqual(dispatched.env, [
    ...controlEnv({ base: "https://cp", token: "t", execId: 1, nodeId: "n" }),
    { k: "foo", v: "bar" }, { k: "num", v: "5" },
  ]);
});

test("shell step：无 environment 时 env 仅含引导变量（无节点 env 与 environment）", async () => {
  let dispatched = null;
  const eciProvider = { dispatch: async (arg) => { dispatched = arg; return { jobRef: "j" }; } };
  const step = makeShellStep({ eciProvider, genToken: () => "t", controlPlaneBase: "https://cp" });
  const node = { id: "n", type: "shell", params: { image: "i", command: "c", env: [] } };
  await step(node, { execId: 1, recordRegistry: async () => {} });
  assert.deepEqual(dispatched.env, controlEnv({ base: "https://cp", token: "t", execId: 1, nodeId: "n" }));
});

test("shell step：显式 outputs 时输出 key 列表来自声明", async () => {
  const eciProvider = { dispatch: async () => ({ jobRef: "j" }) };
  const step = makeShellStep({ eciProvider, genToken: () => "t", controlPlaneBase: "https://cp" });
  const node = {
    id: "n", type: "shell",
    params: { image: "i", command: "c", outputs: [{ key: "artifact" }, { key: "sha" }] },
  };
  const out = await step(node, { execId: 1, recordRegistry: async () => {} });
  assert.deepEqual(out.outputKeys, ["artifact", "sha"]);
});