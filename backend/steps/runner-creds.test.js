import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleRunnerCredentials, validateCredRefs, RUNNER_CRED_KINDS } from "./runner-creds.js";

const pool = new Map([
  ["ssh-dev", { kind: "ssh", secret: { privateKey: "KEY\n" } }],
  ["mvn", { kind: "maven", secret: { serverId: "nexus", username: "u", password: "p" } }],
  ["reg", { kind: "docker-registry", secret: { registry: "reg.example.com", username: "u", password: "p" } }],
  ["npm", { kind: "npm", secret: { registry: "https://npm.example.com/", token: "tk" } }],
  ["s3", { kind: "s3", secret: { endpoint: "oss.example.com", bucket: "b", ak: "a", sk: "s" } }],
]);
const getCred = async (name) => pool.get(name) ?? null;

test("assemble：按类型映射短 key 并透传字段，docker-registry→docker", async () => {
  const out = await assembleRunnerCredentials({
    refs: [{ name: "ssh-dev" }, { name: "mvn" }, { name: "reg" }, { name: "npm" }, { name: "s3" }],
    getCredential: getCred,
  });
  assert.deepEqual(out.ssh, { privateKey: "KEY\n", passphrase: "", knownHosts: "" });
  assert.deepEqual(out.maven, { serverId: "nexus", username: "u", password: "p", registryUrl: "" });
  assert.deepEqual(out.docker, { registry: "reg.example.com", username: "u", password: "p" });
  assert.deepEqual(out.npm, { registry: "https://npm.example.com/", token: "tk" });
  assert.deepEqual(out.s3, { endpoint: "oss.example.com", bucket: "b", ak: "a", sk: "s" });
});

test("assemble：空引用/空名忽略；凭证缺失或类型不允许报可读错误", async () => {
  assert.deepEqual(await assembleRunnerCredentials({ refs: [], getCredential: getCred }), {});
  assert.deepEqual(await assembleRunnerCredentials({ refs: [{ name: "" }], getCredential: getCred }), {});
  await assert.rejects(
    assembleRunnerCredentials({ refs: [{ name: "ghost" }], getCredential: getCred }),
    /附加凭证 "ghost" 不存在/
  );
  await assert.rejects(
    assembleRunnerCredentials({ refs: [{ name: "eci-cred" }], getCredential: async () => ({ kind: "eci", secret: {} }) }),
    /类型 eci 不支持注入容器/
  );
});

test("validateCredRefs：引用存在且类型在允许集则通过；缺失/类型不符返回错误", async () => {
  const lookup = async (name) => (pool.get(name) ? { kind: pool.get(name).kind } : null);
  const ok = {
    nodes: [{ id: "n1", type: "shell", params: { credentials: [{ name: "ssh-dev" }, { name: "npm" }] } }],
  };
  assert.equal(await validateCredRefs(ok, lookup), null);
  const miss = await validateCredRefs({ nodes: [{ id: "n1", params: { credentials: [{ name: "ghost" }] } }] }, lookup);
  assert.match(miss, /不存在的附加凭证 "ghost"/);
  const badKind = await validateCredRefs({ nodes: [{ id: "n1", params: { credentials: [{ name: "k" }] } }] }, async () => ({ kind: "eci" }));
  assert.match(badKind, /类型 eci 不支持注入容器/);
});

test("RUNNER_CRED_KINDS 覆盖 ssh/maven/docker-registry/npm/s3", () => {
  assert.deepEqual([...RUNNER_CRED_KINDS].sort(), ["docker-registry", "maven", "npm", "s3", "ssh"]);
});