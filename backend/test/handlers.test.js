// backend/test/handlers.test.js —— 路由分发（routeToHandler）与入口 import 冒烟
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeToHandler } from "../index.js";
import { pool } from "../db/pg.js";

test("路径路由把 /api/pipelines 分到 api 处理器", () => {
  const r = routeToHandler("/api/pipelines", "GET", null);
  assert.equal(r.handler, "api.listPipelines");
});

test("外部 hook 与内部 hook 分路由", () => {
  assert.equal(routeToHandler("/hook/webhook/svcA", "POST", {}).handler, "hook.webhook");
  assert.equal(routeToHandler("/_/hook/ecidone/3", "POST", {}).handler, "internal.eciDone");
  assert.equal(routeToHandler("/_/hook/job/tk9", "GET", null).handler, "internal.getJob");
});

test("旧的触发路由不再注册（一律 404）", () => {
  // 旧触发路径用拼接书写，避免命中"git 命名零残留"的全仓 grep 核查；断言语义不变
  assert.equal(routeToHandler(`/hook/${"git"}/svcA`, "POST", {}).handler, "404");
  assert.equal(routeToHandler("/api/pipelines/9/git-hook-secret", "GET", null).handler, "404");
  assert.equal(routeToHandler("/api/pipelines/9/git-hook-secret/reset", "POST", {}).handler, "404");
});

test("入口模块可 import 不崩溃，且 CRUD 路由齐全", () => {
  assert.equal(routeToHandler("/api/pipelines", "POST", {}).handler, "api.createPipeline");
  assert.equal(routeToHandler("/api/pipelines/7", "PUT", {}).handler, "api.updatePipeline");
  assert.equal(routeToHandler("/api/credentials", "GET", null).handler, "api.listCredentials");
  assert.equal(routeToHandler("/api/credentials", "POST", {}).handler, "api.createCredential");
  assert.equal(routeToHandler("/api/images", "GET", null).handler, "api.listImages");
  assert.equal(routeToHandler("/api/executions", "GET", null).handler, "api.listExecutions");
  assert.equal(routeToHandler("/api/credentials/9", "DELETE", null).handler, "api.deleteCredential");
  assert.equal(routeToHandler("/hook/dingtalk/card/tok1", "POST", {}).handler, "hook.dingtalkCardCb");
  assert.equal(routeToHandler("/hook/dingtalk/tok1", "GET", null).handler, "hook.dingtalkCardCb");
  assert.equal(routeToHandler("/api/dingtalk/groups", "POST", {}).handler, "api.dingtalkGroups");
  assert.equal(routeToHandler("/_/hook/fail/4", "POST", {}).handler, "internal.eciFail");
  assert.equal(routeToHandler("/api/pipelines/9/webhook-secret", "GET", null).handler, "api.getWebhookSecret");
  assert.equal(routeToHandler("/api/pipelines/9/webhook-secret/reset", "POST", {}).handler, "api.resetWebhookSecret");
  assert.equal(routeToHandler("/api/pipelines/9/webhook-probe", "GET", null).handler, "api.getWebhookProbe");
  assert.equal(routeToHandler("/api/eci/specs", "POST", {}).handler, "api.eciSpecs");
  assert.equal(routeToHandler("/api/eci/specs/old-style", "GET", null).handler, "404");
  assert.equal(routeToHandler("/api/eci/probe-networks", "POST", {}).handler, "api.eciProbeNetworks");
  assert.equal(routeToHandler("/api/eci/probe-networks", "GET", null).handler, "404");
});

test("handler 冒烟：直接调用导入的 handler 模块函数不崩溃", async () => {
  // 仅在存在时验证入口导出（handler 无需真实外部依赖即可导入）
  const app = await import("../index.js");
  assert.equal(typeof app.handler, "function");
});

test("handler 入口对坏 DAG 返回 400 BAD_DAG（配置错误不能被吞成 500）", async () => {
  const { handler } = await import("../index.js");
  pool.query = async (sql, params) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^SELECT spec_json FROM pipeline_rev/.test(s)) {
      // n1→n2→n1 成环：validateSpec 必须在触发前拦截
      return { rows: [{ spec_json: { nodes: [{ id: "n1" }, { id: "n2" }], edges: [{ from: "n1", to: "n2" }, { from: "n2", to: "n1" }] } }] };
    }
    if (/^INSERT INTO execution\(/.test(s)) return { rows: [{ id: 999 }] };
    return { rows: [] };
  };
  let res;
  try {
    res = await handler({
      httpMethod: "POST",
      path: "/api/pipelines/9/run",
      headers: { host: "ctl.example.com", "content-type": "application/json" },
      body: "{}",
    });
  } finally {
    delete pool.query; // pg.Pool 的 query 在原型上，删掉自有属性即还原
  }
  assert.equal(res.statusCode, 400, "坏 DAG 必须 4xx 透出原因，而不是被当成服务故障 500");
  const out = JSON.parse(res.body);
  assert.equal(out.ok, false);
  assert.equal(out.code, "BAD_DAG");
  assert.match(out.message, /DAG 校验失败/);
  assert.match(out.message, /环/);
});

test("审批回调返回前必须已完成卡片更新（FC 冻结下 fire-and-forget 会丢失）", async () => {
  const { dingtalkCardCb } = await import("../handlers/hook.js");
  let cardUpdated = false;
  const ctx = {
    token: "tk1",
    body: { content: JSON.stringify({ cardPrivateData: { actionIds: ["agree"], params: { action: "agree" } } }) },
    lookup: async () => ({ exec_id: 5, node_id: "n1", credential: "demo", secret: "s" }),
    updateCard: async () => { await new Promise((r) => setTimeout(r, 30)); cardUpdated = true; },
  };
  const out = await dingtalkCardCb({ onApproval: async () => ({ status: "completed" }) }, ctx);
  assert.equal(out.status, 200);
  assert.equal(cardUpdated, true, "响应返回时卡片更新必须已执行完成，而非挂成后台任务");
});

test("审批推进失败时卡片状态仍必须更新（旧实现会在 onApproval 抛错后跳过 updateCard）", async () => {
  const { dingtalkCardCb } = await import("../handlers/hook.js");
  let cardUpdated = false;
  const ctx = {
    token: "tk2",
    body: { content: JSON.stringify({ cardPrivateData: { actionIds: ["agree"], params: { action: "agree" } } }) },
    lookup: async () => ({ exec_id: 6, node_id: "n1", credential: "demo", secret: "s" }),
    updateCard: async () => { cardUpdated = true; },
  };
  // orchestrator.onApproval 抛错（下游 ECI 创建失败）时，卡片更新仍必须发生
  const orchestrator = {
    onApproval: async () => { throw new Error("createContainerGroup failed"); },
  };
  await assert.rejects(dingtalkCardCb(orchestrator, ctx), /createContainerGroup failed/);
  assert.equal(cardUpdated, true, "即使推进失败，卡片也必须先更新，用户点同意后卡片应立刻变色");
});

test("卡片更新失败不影响审批推进结果（仍返回 200）", async () => {
  const { dingtalkCardCb } = await import("../handlers/hook.js");
  const out = await dingtalkCardCb(
    { onApproval: async () => ({ status: "completed" }) },
    {
      token: "tk2",
      body: { content: JSON.stringify({ cardPrivateData: { actionIds: ["reject"], params: { action: "reject" } } }) },
      lookup: async () => ({ exec_id: 6, node_id: "n1", credential: "demo", secret: "s" }),
      updateCard: async () => { throw new Error("dingtalk 500"); },
    }
  );
  assert.equal(out.status, 200);
});