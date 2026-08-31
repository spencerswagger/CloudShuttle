import { test } from "node:test";
import assert from "node:assert/strict";
import { makeShellStep } from "../steps/shell.js";
import { createEciProvider, parseResource, buildCreateEciRequest } from "../providers/eci.js";

test("parseResource 解析 vCPU/内存", () => {
  assert.deepEqual(parseResource("2 vCPU · 4 GiB"), { cpu: 2, memory: 4 });
  assert.deepEqual(parseResource("1 vCPU · 1 Gi"), { cpu: 1, memory: 1 });
  assert.deepEqual(parseResource(""), { cpu: undefined, memory: undefined });
  assert.deepEqual(parseResource("0.5 cpu · 2 gib"), { cpu: 0.5, memory: 2 });
});

test("buildCreateEciRequest 拼 CreateContainerGroup 参数", () => {
  const req = buildCreateEciRequest({
    name: "cloudshuttle-1-n1",
    image: "alpine",
    command: "echo hi",
    env: [{ k: "A", v: "1" }],
    resource: "2 vCPU · 4 GiB",
    timeout: 300,
    eci: {
      accessKeyId: "ak", accessKeySecret: "sk", regionId: "cn-hangzhou",
      vswitchId: "vsw-1", securityGroupId: "sg-1",
    },
  });
  assert.equal(req.regionId, "cn-hangzhou");
  assert.equal(req.containerGroupName, "cloudshuttle-1-n1");
  assert.equal(req.securityGroupId, "sg-1");
  assert.equal(req.vSwitchId, "vsw-1");
  assert.equal(req.cpu, 2);
  assert.equal(req.memory, 4);
  assert.equal(req.activeDeadlineSeconds, 300);
  assert.equal(req.clientToken, "cloudshuttle-1-n1");
  assert.deepEqual(req.container[0].environmentVar, [{ key: "A", value: "1" }]);
  assert.deepEqual(req.container[0].image, "alpine");
});

test("createEciProvider.dispatch 透传 eci 配置并拼容器组名", async () => {
  let got = null;
  const provider = createEciProvider({ create: async (p) => { got = p; return "eci-xxx"; } });
  const { jobRef } = await provider.dispatch({
    execId: 7, nodeId: "n2", image: "alpine", command: "x",
    env: [], resource: "1 vCPU · 1 GiB", timeout: 60,
    callbackUrl: "cb", token: "tok", eci: { regionId: "cn-hangzhou" },
  });
  assert.equal(jobRef, "eci-xxx");
  assert.equal(got.name, "cloudshuttle-7-n2");
  assert.deepEqual(got.eci, { regionId: "cn-hangzhou" });
});

test("buildCreateEciRequest 缺 eci 配置时抛错", () => {
  assert.throws(() => buildCreateEciRequest({ name: "x", image: "a" }), /eci credential config missing/);
});

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