import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKubeconfig, k8sJobManifest, createK8sProvider, k8sErrorHint } from "../providers/k8s.js";

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

test("k8sJobManifest：runner 契约、env 转 name/value、Job 默认与可选规格", () => {
  const m = k8sJobManifest({
    name: "cs1-n1", namespace: "build",
    image: "cloudshuttle/runner:0.1",
    env: [{ k: "A", v: 1 }, { k: "", v: "x" }],
    activeDeadlineSeconds: 300,
    ttlSecondsAfterFinished: 60,
  });
  assert.equal(m.kind, "Job");
  assert.equal(m.spec.backoffLimit, 0);
  assert.equal(m.spec.activeDeadlineSeconds, 300);
  assert.equal(m.spec.ttlSecondsAfterFinished, 60);
  const c = m.spec.template.spec.containers[0];
  assert.deepEqual(c.command, ["/bin/sh", "/app/run.sh"]);
  assert.deepEqual(c.env, [{ name: "A", value: "1" }]);
  assert.equal(m.spec.template.spec.restartPolicy, "Never");
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
    name: "cs1-n1", image: "img",
  });
  assert.equal(got.name, "cs1-n1");
  assert.equal(got.uid, "u");
  assert.ok(calls[0].url.endsWith("/apis/batch/v1/namespaces/ns0/jobs"));
  assert.equal(calls[0].body.metadata.name, "cs1-n1");
  assert.match(calls[0].body.spec.template.spec.containers[0].image, /img/);

  await assert.rejects(
    provider.createJob({
      kube: { server: "https://k8s.example.com", token: "t", namespace: "ns0" },
      name: "x", image: "i", env: [{ k: "environmentMarker", v: "boom" }], backoffLimit: 0,
    }),
    /创建 Kubernetes Job 失败：.*Forbidden/
  );
  const errTxt = k8sErrorHint({ message: "connect 10.0.0.5:6443 denied for user dev" }, "https://10.0.0.5:6443");
  assert.ok(!errTxt.includes("10.0.0.5"), "集群内网地址不应泄露");
  assert.ok(!errTxt.includes("dev"), "账号不应泄露");
});

test("ping：200 视为可达，异常抛错", async () => {
  const provider = createK8sProvider({ buildClient: () => ({ get: async () => ({ status: 200 }) }) });
  assert.equal(await provider.ping({ server: "https://k", token: "t" }), true);
  const bad = createK8sProvider({ buildClient: () => ({ get: async () => { throw new Error("boom"); } }) });
  await assert.rejects(bad.ping({ server: "https://k", token: "t" }), /boom/);
});