// backend/test/webhook.test.js —— webhook 触发链路的纯逻辑与关键行为
// 覆盖：URL 后端生成（buildWebhookUrl）、调试探针（probeStatement / recordProbe / 记录点）、
// 密钥校验分支、以及 routeToHandler 与 DISPATCH 的双注册一致性。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWebhookUrl } from "../handlers/api.js";
import { webhook, recordProbe, probeStatement } from "../handlers/hook.js";
import { routeToHandler, isDispatched } from "../index.js";

test("buildWebhookUrl 用 base 拼出完整回调地址并对 name 做编码", () => {
  const url = buildWebhookUrl({ base: "http://localhost:9000", name: "demo rollout", secret: "uuid-1" });
  assert.equal(url, "http://localhost:9000/hook/webhook/demo%20rollout?secret=uuid-1");
});

test("buildWebhookUrl 去掉 base 结尾斜杠，避免双斜杠", () => {
  assert.equal(
    buildWebhookUrl({ base: "https://ctl.example.com/", name: "svcA", secret: "s" }),
    "https://ctl.example.com/hook/webhook/svcA?secret=s"
  );
});

test("buildWebhookUrl 在 base 缺失时退化为站点相对路径（前端可补 origin）", () => {
  assert.equal(buildWebhookUrl({ name: "svcA", secret: "s" }), "/hook/webhook/svcA?secret=s");
  // name/secret 缺失时按空串处理，不写出字面量 "undefined"
  assert.equal(buildWebhookUrl({ base: "", name: undefined, secret: undefined }), "/hook/webhook/?secret=");
});

test("probeStatement 生成按管道主键的 UPSERT，body 序列化为 JSON 字符串", () => {
  const { sql, params } = probeStatement(7, { ref: "refs/heads/main" });
  assert.match(sql, /INSERT INTO webhook_probe\(pipeline_id, body\)/);
  assert.match(sql, /ON CONFLICT \(pipeline_id\) DO UPDATE SET body=EXCLUDED\.body, received_at=now\(\)/);
  assert.equal(params[0], 7);
  assert.equal(params[1], JSON.stringify({ ref: "refs/heads/main" }));
});

test("probeStatement 在 body 缺省时写入空对象而非 null", () => {
  assert.equal(probeStatement(1, undefined).params[1], "{}");
  assert.equal(probeStatement(1, null).params[1], "{}");
});

test("recordProbe 成功时按 UPSERT 落库一次", async () => {
  const seen = [];
  await recordProbe(3, { a: 1 }, async (sql, params) => { seen.push([sql, params]); });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][1][0], 3);
  assert.deepEqual(JSON.parse(seen[0][1][1]), { a: 1 });
});

test("recordProbe 写库失败只告警，不抛出（绝不影响 webhook 主流程）", async () => {
  const warn = [];
  const orig = console.warn;
  console.warn = (...args) => warn.push(args.join(" "));
  try {
    await recordProbe(9, { a: 1 }, async () => { throw new Error("db down"); });
  } finally {
    console.warn = orig;
  }
  assert.equal(warn.length, 1);
  assert.match(warn[0], /探针写入失败 pipeline=9/);
});

// 用注入的 resolve/probe 驱动 webhook，不依赖真实库
function harness({ secret } = {}) {
  const probes = [];
  const runs = [];
  return {
    probes,
    runs,
    resolve: async () => ({ pipelineId: 42, webhookSecret: secret }),
    probe: async (pipelineId, body) => { probes.push([pipelineId, body]); },
    run: async (arg) => { runs.push(arg); return { waiting: "n1" }; },
  };
}

test("webhook 密钥正确：记录探针后转交 run 并返回 200", async () => {
  const h = harness({ secret: "s3cret" });
  const out = await webhook(h.run, {
    pipelineName: "svcA", payload: { ref: "main" }, authority: "ctl.example", secret: "s3cret",
    resolve: h.resolve, probe: h.probe,
  });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { ok: true, waiting: "n1" });
  assert.deepEqual(h.probes, [[42, { ref: "main" }]]);
  assert.deepEqual(h.runs, [{ pipelineId: 42, payload: { ref: "main" }, authority: "ctl.example" }]);
});

test("webhook 密钥错误：仍记录探针（记录点早于校验），返回 401 且未触发 run", async () => {
  const h = harness({ secret: "s3cret" });
  const out = await webhook(h.run, {
    pipelineName: "svcA", payload: { whatever: true }, authority: null, secret: "wrong",
    resolve: h.resolve, probe: h.probe,
  });
  assert.equal(out.status, 401);
  assert.equal(out.body.code, "UNAUTHORIZED");
  assert.deepEqual(h.probes, [[42, { whatever: true }]], "密钥错误的投递也要留探针");
  assert.equal(h.runs.length, 0);
});

test("webhook 密钥未配置：返回 503 HOOK_NOT_CONFIGURED", async () => {
  const h = harness({ secret: "" });
  const out = await webhook(h.run, {
    pipelineName: "svcA", payload: null, secret: "x", resolve: h.resolve, probe: h.probe,
  });
  assert.equal(out.status, 503);
  assert.equal(out.body.code, "HOOK_NOT_CONFIGURED");
  assert.deepEqual(h.probes, [[42, {}]], "payload 缺省时探针记录空对象");
});

test("routeToHandler 命中的处理器在 DISPATCH 中都有登记（双注册，缺一必 404）", () => {
  const routes = [
    ["/hook/webhook/svcA", "POST"],
    ["/api/pipelines/9/webhook-secret", "GET"],
    ["/api/pipelines/9/webhook-secret/reset", "POST"],
    ["/api/pipelines/9/webhook-probe", "GET"],
    ["/api/pipelines", "GET"],
    ["/api/pipelines/9", "GET"],
    ["/api/pipelines/9/run", "POST"],
    ["/api/executions/3/rerun", "POST"],
    ["/hook/dingtalk/card/tk", "POST"],
    ["/_/hook/ecidone/1", "POST"],
  ];
  for (const [path, method] of routes) {
    const { handler } = routeToHandler(path, method, {});
    assert.notEqual(handler, "404", `${method} ${path} 未被路由`);
    assert.ok(isDispatched(handler), `${handler} 缺少 DISPATCH 登记`);
  }
});
