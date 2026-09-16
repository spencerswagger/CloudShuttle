import { test } from "node:test";
import assert from "node:assert/strict";
import { makeJobStep, jobNameFor } from "./job.js";

const K8S_CRED = "k8s-dev";

function makeStep(k8sProvider, opts = {}) {
  return makeJobStep({
    k8sProvider,
    genToken: () => "t",
    controlPlaneBase: "https://cp.example.com",
    getK8s: async (name) => {
      if (name !== K8S_CRED) throw new Error(`凭证不存在：${name}`);
      return { server: "https://k8s.example.com", namespace: "default" };
    },
    ...opts,
  });
}

test("job 节点：引导变量在前 + 节点 env + environment 环境变量全量下发，回调地址带 token/secret", async () => {
  const calls = [];
  const k8sProvider = { createJob: async (a) => { calls.push(a); return { name: a.name, uid: "u1" }; } };
  const step = makeStep(k8sProvider);
  const res = await step(
    { id: "n1", params: { credential: K8S_CRED, image: "img:1", command: "echo hi", env: [{ k: "A", v: "1" }] } },
    { execId: 7, environment: new Map([["envx", "9"]]), recordRegistry: async () => {} }
  );
  assert.equal(res.kind, "dispatch");
  assert.equal(res.ref, jobNameFor(7, "n1"));
  assert.deepEqual(res.outputKeys, ["step_out"]);
  const job = calls[0];
  assert.equal(job.namespace, "");
  assert.equal(job.image, "img:1");
  const keys = job.env.map((e) => e.k);
  assert.deepEqual(job.env[0], { k: "CLOUDSHUTTLE_JOB_URL", v: "https://cp.example.com/_/hook/job/t" });
  assert.ok(keys.indexOf("A") >= 0, "节点自身 env 应下发");
  assert.ok(keys.indexOf("envx") >= 0, "environment 变量应下发");
  assert.ok(keys.indexOf("CLOUDSHUTTLE_CB_BASE") >= 0);
});

test("job 节点：默认 runner 镜像、backoffLimit=0、timeout→activeDeadlineSeconds、registry kind=job", async () => {
  const calls = [];
  const regs = [];
  const k8sProvider = { createJob: async (a) => { calls.push(a); return { name: a.name }; } };
  const step = makeStep(k8sProvider);
  const res = await step(
    { id: "n2", params: { credential: K8S_CRED, timeout: 30 } },
    { execId: 8, environment: new Map(), recordRegistry: async (r) => regs.push(r) }
  );
  const job = calls[0];
  assert.equal(job.image, "cloudshuttle/runner:0.1");
  assert.equal(job.backoffLimit, 0);
  assert.equal(job.activeDeadlineSeconds, 30000);
  assert.equal(job.ttlSecondsAfterFinished, undefined);
  assert.equal(res.ref, "cs8-n2");
  assert.deepEqual(regs, [{ kind: "job", token: "t", secret: "t", execId: 8, nodeId: "n2" }]);
});

test("job 节点：ttlSecondsAfterFinished 透传、超时 0 不设 activeDeadlineSeconds", async () => {
  const calls = [];
  const k8sProvider = { createJob: async (a) => { calls.push(a); return { name: a.name }; } };
  const step = makeStep(k8sProvider);
  await step(
    { id: "n3", params: { credential: K8S_CRED, ttlSecondsAfterFinished: "3600" } },
    { execId: 9, environment: new Map(), recordRegistry: async () => {} }
  );
  assert.equal(calls[0].ttlSecondsAfterFinished, 3600);
  assert.equal(calls[0].activeDeadlineSeconds, undefined);
});

test("job 节点：未选凭证 / 凭证非 k8s → 可读错误", async () => {
  const k8sProvider = { createJob: async () => ({ name: "" }) };
  await assert.rejects(
    makeStep(k8sProvider)({ id: "n4", params: {} }, { execId: 1, environment: new Map() }),
    /未选择 Kubernetes 凭证/
  );
  const badStep = makeStep(k8sProvider, {
    getK8s: async () => { throw new Error("凭证 \"x\" 不是 Kubernetes 凭证（当前类型：eci）"); },
  });
  await assert.rejects(
    badStep({ id: "n4", params: { credential: "x" } }, { execId: 1, environment: new Map() }),
    /不是 Kubernetes 凭证/
  );
});

test("jobNameFor：非 DNS 字符净化、小写、限长 63", () => {
  assert.equal(jobNameFor(7, "n1"), "cs7-n1");
  assert.equal(jobNameFor(7, "N_2"), "cs7-n-2");
  assert.ok(jobNameFor(123456789, "veryLongNodeId".repeat(6)).length <= 63);
});