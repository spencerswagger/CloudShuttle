import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseKubeconfig, k8sJobManifest, createK8sProvider, k8sErrorHint,
  buildSecretVolumes, secretNameFor,
} from "../providers/k8s.js";

const KUBE = `apiVersion: v1
kind: Config
current-context: dev
clusters:
  - name: dev
    cluster:
      server: https://k8s.example.com:6443
      certificate-authority-data: Q0E9PQ==
      insecure-skip-tls-verify: false
contexts:
  - name: dev
    context:
      cluster: dev
      user: dev-user
      namespace: build
users:
  - name: dev-user
    user:
      token: kube-token-abc
`;

test("parseKubeconfig：token 鉴权 + 上下文 namespace + CA 数据", () => {
  const k = parseKubeconfig(KUBE);
  assert.equal(k.server, "https://k8s.example.com:6443");
  assert.equal(k.token, "kube-token-abc");
  assert.equal(k.caData, "Q0E9PQ==");
  assert.equal(k.namespace, "build");
  assert.equal(k.insecure, false);
});

test("parseKubeconfig：client-cert 与 basic 鉴权、insecure 标志、默认命名空间", () => {
  const k = parseKubeconfig(`apiVersion: v1
kind: Config
current-context: c
clusters:
  - name: c
    cluster:
      server: https://10.0.0.5:6443
      insecure-skip-tls-verify: true
contexts:
  - name: c
    context: { cluster: c, user: u }
users:
  - name: u
    user:
      client-certificate-data: Q0VSVA==
      client-key-data: S0VZ
`);
  assert.equal(k.insecure, true);
  assert.equal(k.clientCertData, "Q0VSVA==");
  assert.equal(k.clientKeyData, "S0VZ");
  assert.equal(k.namespace, "default");

  const basic = parseKubeconfig(`apiVersion: v1
kind: Config
current-context: c
clusters:
  - name: c
    cluster: { server: https://k.example.com }
contexts:
  - name: c
    context: { cluster: c, user: u }
users:
  - name: u
    user: { username: admin, password: pw }
`);
  assert.equal(basic.username, "admin");
  assert.equal(basic.password, "pw");
});

test("parseKubeconfig：非法 YAML / 缺 current-context / server 非 http → 可读错误", () => {
  assert.throws(() => parseKubeconfig("a: [unclosed"), /不是合法 YAML/);
  assert.throws(() => parseKubeconfig("apiVersion: v1\nkind: Config"), /缺少 current-context/);
  assert.throws(() => parseKubeconfig(`apiVersion: v1
kind: Config
current-context: c
clusters:
  - name: c
    cluster: { server: ftp://x.example.com }
contexts:
  - name: c
    context: { cluster: c, user: u }
users:
  - name: u
    user: { token: t }
`), /必须是 http/);
});

test("k8sJobManifest：命令内联进 container.command、env 转 name/value、Job 默认与可选规格", () => {
  const m = k8sJobManifest({
    name: "cs1-n1", namespace: "build",
    image: "node:20-alpine",
    command: "echo hi\ncurl -X POST http://cb",
    env: [{ k: "A", v: 1 }, { k: "", v: "x" }],
    activeDeadlineSeconds: 300,
    ttlSecondsAfterFinished: 60,
  });
  assert.equal(m.kind, "Job");
  assert.equal(m.spec.backoffLimit, 0);
  assert.equal(m.spec.activeDeadlineSeconds, 300);
  assert.equal(m.spec.ttlSecondsAfterFinished, 60);
  const c = m.spec.template.spec.containers[0];
  assert.deepEqual(c.command, ["sh", "-c", "echo hi\ncurl -X POST http://cb"], "用户命令必须直接内联，无平台镜像/初始化脚本");
  assert.equal(c.image, "node:20-alpine");
  assert.deepEqual(c.env, [{ name: "A", value: "1" }]);
  assert.equal(m.spec.template.spec.restartPolicy, "Never");
});

test("k8sJobManifest：env 元素 {k, fromSecret} → valueFrom.secretKeyRef（短值凭据走 Secret）", () => {
  const m = k8sJobManifest({
    name: "cs1-n1", namespace: "ns",
    image: "img", command: "x",
    secretName: "secret-cs1-n1",
    env: [{ k: "CS_SSH_PASSPHRASE", fromSecret: "secret-cs1-n1", secretKey: "ssh_passphrase" }],
  });
  const c = m.spec.template.spec.containers[0];
  assert.deepEqual(c.env, [
    { name: "CS_SSH_PASSPHRASE", valueFrom: { secretKeyRef: { name: "secret-cs1-n1", key: "ssh_passphrase", optional: true } } },
  ]);
});

test("k8sJobManifest：resources（CPU/内存）→ requests 与 limits 同值；未填则不设置", () => {
  const m = k8sJobManifest({
    name: "cs1-n1", namespace: "ns",
    image: "node:20", command: "x",
    resources: { cpu: "1", memory: "2Gi" },
  });
  const c = m.spec.template.spec.containers[0];
  assert.deepEqual(c.resources, { requests: { cpu: "1", memory: "2Gi" }, limits: { cpu: "1", memory: "2Gi" } });
  const m2 = k8sJobManifest({ name: "x", namespace: "ns", image: "i", command: "c" });
  assert.equal(m2.spec.template.spec.containers[0].resources, undefined);
});

test("buildSecretVolumes：单卷 + subPath 挂载；无挂载返回空", () => {
  const { volumes, volumeMounts } = buildSecretVolumes("secret-cs1-n1", [
    { key: "ssh_id_rsa", subPath: "ssh_id_rsa", mountPath: "/root/.ssh/id_rsa" },
    { key: "maven_settings.xml", subPath: "maven_settings.xml", mountPath: "/root/.m2/settings.xml" },
  ]);
  assert.equal(volumes.length, 1);
  assert.equal(volumes[0].name, "cs-creds");
  assert.deepEqual(volumes[0].secret.secretName, "secret-cs1-n1");
  assert.equal(volumeMounts.length, 2);
  assert.equal(volumeMounts[0].mountPath, "/root/.ssh/id_rsa");
  assert.equal(volumeMounts[0].subPath, "ssh_id_rsa");
  assert.deepEqual(buildSecretVolumes("s", []), { volumes: [], volumeMounts: [] });
});

test("secretNameFor：前缀 secret-", () => {
  assert.equal(secretNameFor("cs7-n1"), "secret-cs7-n1");
});

test("createJob：post 到 batch/v1 路径返回 name/uid；失败错误不泄露集群地址", async () => {
  const calls = [];
  const client = {
    post: async (url, body) => {
      calls.push({ url, body });
      if ((body?.spec?.template?.spec?.containers?.[0]?.env ?? []).some((e) => e.name === "environmentMarker" && e.value === "boom")) {
        throw { response: { data: { message: "from https://10.0.0.5:6443: Forbidden" } } };
      }
      return { status: 201, data: { metadata: { uid: "u" } } };
    },
  };
  const provider = createK8sProvider({ buildClient: () => client });
  const got = await provider.createJob({
    kube: { server: "https://k8s.example.com", token: "t", namespace: "ns0" },
    name: "cs1-n1", image: "img", command: "echo ok",
  });
  assert.equal(got.name, "cs1-n1");
  assert.equal(got.uid, "u");
  assert.ok(calls[0].url.endsWith("/apis/batch/v1/namespaces/ns0/jobs"));
  assert.equal(calls[0].body.metadata.name, "cs1-n1");
  assert.equal(calls[0].body.spec.template.spec.containers[0].image, "img");

  await assert.rejects(
    provider.createJob({
      kube: { server: "https://k8s.example.com", token: "t", namespace: "ns0" },
      name: "x", image: "i", command: "c", env: [{ k: "environmentMarker", v: "boom" }], backoffLimit: 0,
    }),
    /创建 Kubernetes Job 失败：.*Forbidden/
  );
  const errTxt = k8sErrorHint({ message: "connect 10.0.0.5:6443 denied for user dev" }, "https://10.0.0.5:6443");
  assert.ok(!errTxt.includes("10.0.0.5"), "集群内网地址不应泄露");
  assert.ok(!errTxt.includes("dev"), "账号不应泄露");
});

test("ensureSecret：创建 Secret 并把 data 值 base64 化", async () => {
  const calls = [];
  const client = {
    post: async (url, body) => { calls.push({ url, body }); return { status: 201 }; },
  };
  const provider = createK8sProvider({ buildClient: () => client });
  await provider.ensureSecret({
    kube: { server: "https://k", token: "t", namespace: "ns0" },
    name: "secret-cs1-n1", namespace: "ns0",
    data: { ssh_id_rsa: "BEGIN KEY\nEND" },
  });
  const created = calls.find((c) => c.url.endsWith("/api/v1/namespaces/ns0/secrets"));
  assert.ok(created, "必须 POST 创建 Secret");
  assert.equal(created.body.kind, "Secret");
  assert.equal(created.body.data.ssh_id_rsa, Buffer.from("BEGIN KEY\nEND", "utf8").toString("base64"), "Secret.data 值必须 base64 编码");
});

test("attachSecretOwnerRef：merge-patch 挂 ownerReferences 到 Job，失败只告警不抛", async () => {
  const patches = [];
  let fail = false;
  const client = {
    patch: async (url, body) => {
      if (fail) throw new Error("patch denied");
      patches.push({ url, body });
      return { status: 200 };
    },
  };
  const provider = createK8sProvider({ buildClient: () => client });
  await provider.attachSecretOwnerRef({
    kube: { server: "https://k", token: "t", namespace: "ns0" },
    secretName: "secret-cs1-n1", jobName: "cs1-n1", jobUid: "uid-1", namespace: "ns0",
  });
  assert.ok(patches.length === 1);
  assert.ok(patches[0].url.includes("/secrets/secret-cs1-n1"));
  assert.deepEqual(patches[0].body.metadata.ownerReferences, [
    { apiVersion: "batch/v1", kind: "Job", name: "cs1-n1", uid: "uid-1" },
  ]);
  // ownerRef 补挂失败不允许影响执行结果（仅告警）
  fail = true;
  await provider.attachSecretOwnerRef({
    kube: { server: "https://k", token: "t", namespace: "ns0" },
    secretName: "secret-cs1-n1", jobName: "cs1-n1", jobUid: "uid-1", namespace: "ns0",
  });
});

test("deleteSecret：回滚删除凭据 Secret（失败只告警）", async () => {
  let deleted = null;
  const client = {
    delete: async (url) => { deleted = url; return { status: 200 }; },
  };
  const provider = createK8sProvider({ buildClient: () => client });
  await provider.deleteSecret({
    kube: { server: "https://k", token: "t", namespace: "ns0" },
    name: "secret-cs1-n1", namespace: "ns0",
  });
  assert.ok(deleted?.includes("/secrets/secret-cs1-n1"));
});

test("ping：200 视为可达，异常抛错", async () => {
  const provider = createK8sProvider({ buildClient: () => ({ get: async () => ({ status: 200 }) }) });
  assert.equal(await provider.ping({ server: "https://k", token: "t" }), true);
  const bad = createK8sProvider({ buildClient: () => ({ get: async () => { throw new Error("boom"); } }) });
  await assert.rejects(bad.ping({ server: "https://k", token: "t" }), /boom/);
});