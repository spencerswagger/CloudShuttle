import { test } from "node:test";
import assert from "node:assert/strict";
import { makeShellStep, outputKeysOf, buildWrapperCommand, jobNameFor } from "./shell.js";

const K8S_CRED = "k8s-dev";
const builtinGetCredential = async (name) => {
  switch (name) {
    case "ssh-cred":
      return { kind: "ssh", secret: { privateKey: "KEY", knownHosts: "github.com ssh-ed25519 AAAA", passphrase: "pw" } };
    case "maven-cred":
      return { kind: "maven", secret: { serverId: "nexus", username: "u", password: "p", registryUrl: "https://nexus.example.com/repo" } };
    case "maven-empty":
      return { kind: "maven", secret: {} };
    default:
      return { kind: null, secret: null };
  }
};

function makeStep(k8sProvider, opts = {}) {
  return makeShellStep({
    k8sProvider,
    genToken: () => "t",
    controlPlaneBase: "https://cp.example.com",
    getK8s: async (name) => {
      if (name !== K8S_CRED) throw new Error(`凭证不存在：${name}`);
      return { server: "https://k8s.example.com", namespace: "default" };
    },
    getCredential: builtinGetCredential,
    ...opts,
  });
}

test("shell 节点：命令内联（无 runner/CLOUDSHUTTLE_JOB_URL）、引导变量在 env 末尾、回调 URL 带 token/secret", async () => {
  const calls = [];
  const k8sProvider = {
    createJob: async (a) => { calls.push(a); return { name: a.name, uid: "u1" }; },
  };
  const step = makeStep(k8sProvider);
  const res = await step(
    { id: "n1", params: { credential: K8S_CRED, image: "node:20-alpine", command: "echo hi", env: [{ k: "A", v: "1" }] } },
    { execId: 7, environment: new Map([["envx", "9"]]), recordRegistry: async () => {} }
  );
  assert.equal(res.kind, "dispatch");
  assert.equal(res.ref, jobNameFor(7, "n1"));
  assert.deepEqual(res.outputKeys, ["step_out"]);
  const job = calls[0];
  assert.equal(job.namespace, "");
  assert.equal(job.image, "node:20-alpine");
  assert.match(job.command, /echo hi/, "用户命令必须出现在内联命令里");
  assert.match(job.command, /\/_\/hook\/ecidone\/7\?token=t&secret=t/, "成功回调 URL");
  assert.match(job.command, /\/_\/hook\/fail\/7\?token=t&secret=t/, "失败回调 URL");
  assert.ok(!job.command.includes("run.sh"), "不依赖平台 run.sh");
  const keys = job.env.map((e) => e.k);
  assert.equal(job.env.at(-1).k, "CLOUDSHUTTLE_EXEC_ID", "引导变量在 env 末尾（同名不可覆盖）");
  assert.ok(!keys.includes("CLOUDSHUTTLE_JOB_URL"), "命令已内联，不应再有拉取端点变量");
  assert.ok(keys.indexOf("A") >= 0, "节点自身 env 应下发");
  assert.ok(keys.indexOf("envx") >= 0, "environment 变量应下发");
});

test("shell 节点：backoffLimit=0、timeout→activeDeadlineSeconds（秒）、TTL 透传、registry kind=job", async () => {
  const calls = [];
  const regs = [];
  const k8sProvider = { createJob: async (a) => { calls.push(a); return { name: a.name }; } };
  const step = makeStep(k8sProvider);
  const res = await step(
    { id: "n2", params: { credential: K8S_CRED, timeout: 30, ttlSecondsAfterFinished: "3600" } },
    { execId: 8, environment: new Map(), recordRegistry: async (r) => regs.push(r) }
  );
  const job = calls[0];
  assert.equal(job.backoffLimit, 0);
  assert.equal(job.activeDeadlineSeconds, 30, "activeDeadlineSeconds 单位是秒，直接透传节点超时");
  assert.equal(job.ttlSecondsAfterFinished, 3600);
  assert.equal(res.ref, "cs8-n2");
  assert.deepEqual(regs, [{ kind: "job", token: "t", secret: "t", execId: 8, nodeId: "n2" }]);
});

test("shell 节点：附加凭证 → 建 Secret（base64 走 provider）+ subPath 落盘 + 短值 secretKeyRef + ownerRef 托管", async () => {
  const ops = [];
  const j = {
    createJob: async (a) => { ops.push({ op: "job", a }); a._resp = { name: a.name, uid: "uid-9" }; return a._resp; },
    ensureSecret: async ({ name, data }) => { ops.push({ op: "secret", name, data }); return name; },
    deleteSecret: async (p) => ops.push({ op: "deleteSecret", ...p }),
    attachSecretOwnerRef: async (p) => ops.push({ op: "attach", ...p }),
  };
  const step = makeStep(j);
  await step(
    { id: "n1", params: { credential: K8S_CRED, credentials: [{ name: "ssh-cred" }, { name: "maven-cred" }] } },
    { execId: 9, environment: new Map([["item", "x"]]), recordRegistry: async () => {} }
  );
  const secretOp = ops.find((o) => o.op === "secret");
  assert.ok(secretOp, "必须创建凭据 Secret");
  assert.equal(secretOp.name, "secret-cs9-n1");
  assert.equal(secretOp.data.ssh_id_rsa, "KEY\n");
  assert.ok(secretOp.data.ssh_known_hosts.includes("github.com"));
  assert.equal(secretOp.data.ssh_passphrase, "pw");
  assert.ok(secretOp.data.maven_settings_xml || secretOp.data["maven_settings.xml"], "maven settings.xml 进入 Secret");
  const jobOp = ops.find((o) => o.op === "job");
  assert.ok(jobOp.a.volumes.length === 1, "存在凭据卷");
  const mounts = jobOp.a.volumeMounts ?? [];
  assert.ok(mounts.some((m) => m.mountPath === "/root/.ssh/id_rsa" && m.subPath === "ssh_id_rsa"));
  assert.ok(mounts.some((m) => m.mountPath === "/root/.m2/settings.xml"));
  // 短值（ssh 口令）走 secretKeyRef，不落明文 env
  const passEntry = jobOp.a.env.find((e) => e.k === "CS_SSH_PASSPHRASE");
  assert.equal(passEntry.fromSecret, "secret-cs9-n1");
  assert.equal(passEntry.secretKey, "ssh_passphrase");
  // job 创建成功后补挂 ownerRef，保证 TTL 清理时 Secret 随 Job GC
  const attach = ops.find((o) => o.op === "attach");
  assert.ok(attach, "创建 Job 后必须补挂 ownerReferences");
  assert.equal(attach.jobName, "cs9-n1");
  assert.equal(attach.jobUid, "uid-9");
});

test("shell 节点：createJob 失败回滚删除已建 Secret", async () => {
  const deletes = [];
  const j = {
    createJob: async () => { const e = new Error("创建 Kubernetes Job 失败：boom"); throw e; },
    ensureSecret: async ({ name }) => name,
    deleteSecret: async (p) => { deletes.push(p); },
  };
  const step = makeStep(j);
  await assert.rejects(
    step(
      { id: "n1", params: { credential: K8S_CRED, credentials: [{ name: "ssh-cred" }] } },
      { execId: 5, environment: new Map(), recordRegistry: async () => {} }
    ),
    /boom/
  );
  assert.equal(deletes.length, 1, "Job 创建失败必须回滚删除 Secret 防残留");
  assert.equal(deletes[0].name, "secret-cs5-n1");
});

test("shell 节点：无附加凭证不建 Secret，env 无 CS_SSH", async () => {
  const j = {
    createJob: async (a) => { assert.equal(a.volumes.length, 0); assert.equal(a.volumeMounts.length, 0); assert.ok(a.secretName === undefined); return { name: a.name }; },
    ensureSecret: async () => assert.fail("无凭证不应创建 Secret"),
    attachSecretOwnerRef: async () => assert.fail("无凭证不应挂 ownerRef"),
    deleteSecret: async () => assert.fail("无凭证不应删除 Secret"),
  };
  const step = makeStep(j);
  await step(
    { id: "n3", params: { credential: K8S_CRED, command: "ls" } },
    { execId: 3, environment: new Map(), recordRegistry: async () => {} }
  );
});

test("shell 节点：附加凭证类型不支持 / 引用不存在 → 直接抛错（节点随之 fail，不建 Job）", async () => {
  const j = {
    createJob: async () => assert.fail("凭证装配失败不应创建 Job"),
    ensureSecret: async () => assert.fail("不应创建 Secret"),
    deleteSecret: async () => assert.fail("未建 Secret 不应删"),
  };
  const step = makeStep(j);
  await assert.rejects(
    step({ id: "n4", params: { credential: K8S_CRED, credentials: [{ name: "ghost" }] } }, { execId: 2, environment: new Map() }),
    /附加凭证 "ghost" 不存在/
  );
});

test("shell 节点：未选凭证 / 凭证非 k8s → 可读错误", async () => {
  const k8sProvider = { createJob: async () => ({ name: "" }) };
  await assert.rejects(
    makeStep(k8sProvider)({ id: "n4", params: {} }, { execId: 1, environment: new Map() }),
    /未选择 Kubernetes 集群凭证/
  );
  const badStep = makeStep(k8sProvider, {
    getK8s: async () => { throw new Error("凭证 \"x\" 不是 Kubernetes 凭证（当前类型：eci）"); },
  });
  await assert.rejects(
    badStep({ id: "n4", params: { credential: "x" } }, { execId: 1, environment: new Map() }),
    /不是 Kubernetes 凭证/
  );
});

test("shell 节点：资源规格（CPU/内存）透传 createJob（requests 与 limits 同值由 provider 侧落实）", async () => {
  const calls = [];
  const k8sProvider = {
    createJob: async (a) => { calls.push(a); return { name: a.name, uid: "u1" }; },
  };
  const step = makeStep(k8sProvider);
  await step(
    { id: "n1", params: { credential: K8S_CRED, image: "node:20", command: "echo x", cpu: "1", memory: "2Gi" } },
    { execId: 21, environment: new Map(), recordRegistry: async () => {} }
  );
  assert.deepEqual(calls[0].resources, { cpu: "1", memory: "2Gi" });
  // 未填资源不设置
  const calls2 = [];
  const step2 = makeStep({ createJob: async (a) => { calls2.push(a); return { name: a.name }; } });
  await step2(
    { id: "n9", params: { credential: K8S_CRED, image: "node:20", command: "echo x" } },
    { execId: 22, environment: new Map(), recordRegistry: async () => {} }
  );
  assert.equal(calls2[0].resources, undefined);
});

test("shell 节点：配置 CALLBACK_BASE_INTERNAL 后回调/引导变量走内网前缀，未配置仍走外网", async () => {
  const calls = [];
  const step = makeStep(
    { createJob: async (a) => { calls.push(a); return { name: a.name }; } },
    { callbackBaseInternal: "http://fc-internal:9000" }
  );
  await step(
    { id: "n1", params: { credential: K8S_CRED, image: "node:20", command: "echo x" } },
    { execId: 23, environment: new Map(), recordRegistry: async () => {} }
  );
  assert.match(calls[0].command, /http:\/\/fc-internal:9000\/_\/hook\/ecidone\/23/, "回调 URL 应使用内网前缀");
  const cbBase = calls[0].env.find((e) => e.k === "CLOUDSHUTTLE_CB_BASE");
  assert.equal(cbBase?.v, "http://fc-internal:9000");
  // 未配置内网前缀：仍用外网 controlPlaneBase
  const calls2 = [];
  await makeStep({ createJob: async (a) => { calls2.push(a); return { name: a.name }; } })(
    { id: "n2", params: { credential: K8S_CRED, image: "node:20", command: "echo x" } },
    { execId: 24, environment: new Map(), recordRegistry: async () => {} }
  );
  assert.match(calls2[0].command, /https:\/\/cp\.example\.com\/_\/hook\/ecidone\/24/);
});

test("buildWrapperCommand：包含用户命令、日志完整回传（3MB 上限+截断标记）、成功/失败回调与退出码", () => {
  const w = buildWrapperCommand("npm run build", { base: "https://cp", execId: 12, token: "tk", secret: "sk" });
  assert.match(w, /npm run build/);
  assert.match(w, /wc -c < \/tmp\/run\.log/, "通过 wc 判断日志是否超限，避免大日志丢回调");
  assert.match(w, /-gt 3145728/, "日志上限 3MB");
  assert.match(w, /CS_LOG_TRUNCATED/, "超限时写截断标记");
  assert.match(w, /base64 -w0 < "\$CLOUDSHUTTLE_OUT_FILE"/, "输出 base64 完整回传");
  assert.match(w, /--data-binary @\/tmp\/cb\.json/, "body 用文件组装，绕开 ARG_MAX");
  assert.match(w, /exit \$rc/);
  assert.match(w, /\/_\/hook\/ecidone\/12\?token=tk&secret=sk/);
  assert.match(w, /\/_\/hook\/fail\/12\?token=tk&secret=sk/);
});

test("outputKeysOf：默认 step_out；显式 outputs 生效", () => {
  assert.deepEqual(outputKeysOf({}), ["step_out"]);
  assert.deepEqual(outputKeysOf({ outputs: [{ key: "a" }, { key: "b" }] }), ["a", "b"]);
  assert.deepEqual(outputKeysOf({ outputs: [] }), ["step_out"]);
});

test("jobNameFor：非 DNS 字符净化、小写、限长 63", () => {
  assert.equal(jobNameFor(7, "n1"), "cs7-n1");
  assert.equal(jobNameFor(7, "N_2"), "cs7-n-2");
  assert.ok(jobNameFor(123456789, "veryLongNodeId".repeat(6)).length <= 63);
});