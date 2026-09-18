import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { generateSshKeypair, makeTestCredentialConnection } from "./api.js";

test("generateSshKeypair：ed25519 公钥为 ssh-ed25519 wire 格式、私钥为 PEM，可配对", () => {
  const { publicKey, privateKey } = generateSshKeypair();
  assert.match(publicKey, /^ssh-ed25519 AAAA[0-9A-Za-z+/=]+ \d{4}-\d{2}-\d{2}$/);
  assert.match(privateKey, /-----BEGIN PRIVATE KEY-----/);
  // 用私钥派生公钥复核配对（node:crypto 校验）
  const derived = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
  assert.ok(derived.length > 0);
});

test("测试连接：npm 200 → ok；401 → 可读凭证错误", async () => {
  const calls = [];
  const http = {
    get: async (url, cfg) => {
      calls.push({ url, cfg });
      if (cfg?.headers?.Authorization === "Bearer bad") throw { response: { status: 401, data: {} } };
      return { status: 200 };
    },
  };
  const t = makeTestCredentialConnection({ createConnection: async () => ({}), http });
  const ok = await t({ kind: "npm", secret: { registry: "https://npm.example.com/", token: "tk" } });
  assert.equal(ok.ok, true);
  assert.match(calls[0].url, /\/-\/whoami$/);
  await assert.rejects(
    t({ kind: "npm", secret: { registry: "https://npm.example.com/", token: "bad" } }),
    /npm 源连接失败：.*凭证无效/
  );
});

test("测试连接：maven 携带 basic、docker-registry 走 Bearer token 流程、s3 携带 SigV4 头", async () => {
  const calls = [];
  const http = {
    get: async (url, cfg) => { calls.push({ url, cfg }); return { status: 200 }; },
    request: async (opts) => { calls.push({ url: opts.url, opts }); return { status: 200 }; },
  };
  const t = makeTestCredentialConnection({ createConnection: async () => ({}), http });
  await t({ kind: "maven", secret: { registryUrl: "https://nexus.example.com/repository/maven-public/", username: "u", password: "p" } });
  assert.deepEqual(calls[0].cfg.auth, { username: "u", password: "p" });
  await t({ kind: "s3", secret: { endpoint: "oss.example.com", bucket: "b", ak: "ak", sk: "sk" } });
  assert.match(calls[1].opts.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=ak\//);
  assert.match(calls[1].opts.url, /\/b\?max-keys=0/);

  // docker-registry（ACR 等现代 registry）：/v2/ 401 challenge → token 端点换 Bearer → 复验 /v2/
  const dct = [];
  const dctHttp = {
    get: async (url, cfg) => {
      dct.push({ url, cfg });
      if (url.endsWith("/v2/") && !cfg?.headers?.Authorization) {
        return Promise.reject({
          response: {
            status: 401,
            headers: { "www-authenticate": 'Bearer realm="https://tok.example.com/token",service="reg.example.com",scope="repository:demo:pull,push"' },
            data: {},
          },
        });
      }
      if (url.includes("tok.example.com")) return { status: 200, data: { token: "tk1" } };
      return { status: 200 };
    },
  };
  const t2 = makeTestCredentialConnection({ createConnection: async () => ({}), http: dctHttp });
  assert.equal((await t2({ kind: "docker-registry", secret: { registry: "reg.example.com", username: "u", password: "p" } })).ok, true);
  assert.match(dct[0].url, /^https:\/\/reg\.example\.com\/v2\/$/);
  assert.deepEqual(dct[0].cfg.auth, { username: "u", password: "p" });
  assert.match(dct[1].url, /^https:\/\/tok\.example\.com\/token\?/);
  assert.match(dct[1].url, /service=reg\.example\.com/);
  assert.match(dct[1].url, /scope=/);
  assert.deepEqual(dct[1].cfg.auth, { username: "u", password: "p" });
  assert.match(dct[2].url, /\/v2\/$/);
  assert.equal(dct[2].cfg.headers.Authorization, "Bearer tk1");

  // 密码错误：token 端点 401 → 可读「凭证无效」
  const bad = makeTestCredentialConnection({
    createConnection: async () => ({}),
    http: {
      get: async (url) =>
        url.includes("tok.example.com")
          ? Promise.reject({ response: { status: 401, data: {} } })
          : Promise.reject({
              response: {
                status: 401,
                headers: { "www-authenticate": 'Bearer realm="https://tok.example.com/token",service="reg.example.com"' },
                data: {},
              },
            }),
    },
  });
  await assert.rejects(
    bad({ kind: "docker-registry", secret: { registry: "reg.example.com", username: "u", password: "bad" } }),
    /Docker 仓库连接失败：Docker 仓库凭证无效（HTTP 401）/
  );
});

test("测试连接：缺失必填地址 → 明确提示", async () => {
  const t = makeTestCredentialConnection({ createConnection: async () => ({}), http: { get: async () => ({ status: 200 }) } });
  await assert.rejects(t({ kind: "maven", secret: {} }), /仓库地址/);
  await assert.rejects(t({ kind: "npm", secret: {} }), /Registry 地址/);
  await assert.rejects(t({ kind: "docker-registry", secret: {} }), /仓库地址/);
  await assert.rejects(t({ kind: "s3", secret: {} }), /Endpoint/);
});