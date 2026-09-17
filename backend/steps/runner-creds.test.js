import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleRunnerCredentials, validateCredRefs, RUNNER_CRED_KINDS, CRED_FILE_LAYOUT, CRED_ENV_LAYOUT } from "./runner-creds.js";

const CREDS = {
  "ssh-cred": { kind: "ssh", secret: { privateKey: "KEY", knownHosts: "github.com ssh-ed25519 AAAA", passphrase: "pw" } },
  "maven-cred": { kind: "maven", secret: { serverId: "nexus", username: "u", password: "p", registryUrl: "https://nexus.example.com/repo" } },
  "maven-empty": { kind: "maven", secret: {} },
  "docker-cred": { kind: "docker-registry", secret: { registry: "reg.example.com", username: "u", password: "p" } },
  "npm-cred": { kind: "npm", secret: { registry: "https://npm.example.com", token: "tok" } },
  "s3-cred": { kind: "s3", secret: { endpoint: "oss.example.com", bucket: "ob", ak: "ak", sk: "sk" } },
  "ghost": { kind: null, secret: null },
  "eci-cred": { kind: "eci", secret: {} },
};

const getCred = async (name) => CREDS[name] ?? null;

test("assembleRunnerCredentials：各类型 → Secret 文件内容与挂载布局", async () => {
  const out = await assembleRunnerCredentials({
    refs: [
      { name: "ssh-cred" }, { name: "maven-cred" }, { name: "docker-cred" },
      { name: "npm-cred" }, { name: "s3-cred" },
    ],
    getCredential: getCred,
  });
  // ssh：私钥/known_hosts/口令
  assert.equal(out.data.ssh_id_rsa, "KEY\n");
  assert.match(out.data.ssh_known_hosts, /github\.com/);
  assert.equal(out.data.ssh_passphrase, "pw");
  // maven：settings.xml（含 mirror）
  assert.match(out.data["maven_settings.xml"], /<id>nexus<\/id>/);
  assert.match(out.data["maven_settings.xml"], /<url>https:\/\/nexus\.example\.com\/repo<\/url>/);
  // docker：auths JSON（base64 user:pass 带冒号）
  const docker = JSON.parse(out.data["docker_config.json"]);
  assert.ok(docker.auths["reg.example.com"].auth.length > 0);
  // npm：//host/:_authToken
  assert.match(out.data.npm_npmrc, /^\/\/npm\.example\.com\/:_authToken=tok/);
  // s3：access_key / host_bucket 模板
  assert.match(out.data.s3_s3cfg, /access_key = ak/);
  assert.match(out.data.s3_s3cfg, /host_bucket = %\(bucket\)s\.oss\.example\.com/);
  // 挂载布局：每个有内容的文件对应一条 subPath 挂载
  const mountPaths = out.mounts.map((m) => m.mountPath);
  assert.ok(mountPaths.includes("/root/.ssh/id_rsa"));
  assert.ok(mountPaths.includes("/root/.m2/settings.xml"));
  assert.ok(mountPaths.includes("/root/.docker/config.json"));
  assert.ok(mountPaths.includes("/root/.npmrc"));
  assert.ok(mountPaths.includes("/root/.s3cfg"));
  // 短值（ssh 口令）不进挂载，走 secretKeyRef envRef
  const sshEnv = out.envRefs.find((e) => e.env === "CS_SSH_PASSPHRASE");
  assert.equal(sshEnv?.key, "ssh_passphrase");
});

test("assembleRunnerCredentials：无引用/空引用/空内容（如 maven 缺 serverId）→ 空数据，不产生挂载", async () => {
  assert.deepEqual(await assembleRunnerCredentials({ refs: [], getCredential: getCred }), { data: {}, mounts: [], envRefs: [] });
  const empty = await assembleRunnerCredentials({ refs: [{ name: "maven-empty" }], getCredential: getCred });
  assert.deepEqual(empty.data, {});
  assert.deepEqual(empty.mounts, []);
});

test("assembleRunnerCredentials：引用不存在/类型不允许 → 可读错误", async () => {
  await assert.rejects(
    assembleRunnerCredentials({ refs: [{ name: "ghost" }], getCredential: getCred }),
    /附加凭证 "ghost" 不存在/
  );
  await assert.rejects(
    assembleRunnerCredentials({ refs: [{ name: "eci-cred" }], getCredential: getCred }),
    /类型 eci 不支持注入容器/
  );
});

test("validateCredRefs：引用存在且类型在允许集则通过；缺失/类型不符返回错误", async () => {
  const lookup = async (name) => (CREDS[name]?.kind ? { kind: CREDS[name].kind } : null);
  const ok = await validateCredRefs(
    { nodes: [{ id: "n1", params: { credentials: [{ name: "ssh-cred" }, { name: "npm-cred" }] } }] },
    lookup
  );
  assert.equal(ok, null);
  const miss = await validateCredRefs({ nodes: [{ id: "n1", params: { credentials: [{ name: "ghost" }] } }] }, lookup);
  assert.match(miss, /引用了不存在的附加凭证 "ghost"/);
  const badKind = await validateCredRefs(
    { nodes: [{ id: "n1", params: { credentials: [{ name: "k" }] } }] },
    async () => ({ kind: "eci" })
  );
  assert.match(badKind, /类型 eci 不支持注入容器/);
});

test("RUNNER_CRED_KINDS 覆盖 ssh/maven/docker-registry/npm/s3；挂载布局完整", () => {
  assert.deepEqual([...RUNNER_CRED_KINDS].sort(), ["docker-registry", "maven", "npm", "s3", "ssh"]);
  assert.deepEqual(Object.keys(CRED_FILE_LAYOUT).sort(), RUNNER_CRED_KINDS.slice().sort());
  assert.deepEqual(Object.keys(CRED_ENV_LAYOUT), ["ssh"]);
});