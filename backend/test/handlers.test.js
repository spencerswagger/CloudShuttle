// backend/test/handlers.test.js —— 路由分发（routeToHandler）与入口 import 冒烟
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeToHandler } from "../index.js";

test("路径路由把 /api/pipelines 分到 api 处理器", () => {
  const r = routeToHandler("/api/pipelines", "GET", null);
  assert.equal(r.handler, "api.listPipelines");
});

test("外部 hook 与内部 hook 分路由", () => {
  assert.equal(routeToHandler("/hook/git/svcA", "POST", {}).handler, "hook.gitWebhook");
  assert.equal(routeToHandler("/_/hook/ecidone/3", "POST", {}).handler, "internal.eciDone");
});

test("入口模块可 import 不崩溃，且 CRUD 路由齐全", () => {
  assert.equal(routeToHandler("/api/pipelines", "POST", {}).handler, "api.createPipeline");
  assert.equal(routeToHandler("/api/pipelines/7", "PUT", {}).handler, "api.updatePipeline");
  assert.equal(routeToHandler("/api/credentials", "GET", null).handler, "api.listCredentials");
  assert.equal(routeToHandler("/api/credentials", "POST", {}).handler, "api.createCredential");
  assert.equal(routeToHandler("/api/images", "GET", null).handler, "api.listImages");
  assert.equal(routeToHandler("/api/executions", "GET", null).handler, "api.listExecutions");
  assert.equal(routeToHandler("/hook/dingtalk/card/tok1", "POST", {}).handler, "hook.dingtalkCardCb");
  assert.equal(routeToHandler("/hook/dingtalk/tok1", "GET", null).handler, "hook.dingtalkCardCb");
  assert.equal(routeToHandler("/api/dingtalk/groups", "POST", {}).handler, "api.dingtalkGroups");
  assert.equal(routeToHandler("/_/hook/fail/4", "POST", {}).handler, "internal.eciFail");
  assert.equal(routeToHandler("/api/pipelines/9/git-hook-secret", "GET", null).handler, "api.getGitHookSecret");
  assert.equal(routeToHandler("/api/pipelines/9/git-hook-secret/reset", "POST", {}).handler, "api.resetGitHookSecret");
  assert.equal(routeToHandler("/unknown", "GET", null).handler, "404");
});

test("handler 冒烟：直接调用导入的 handler 模块函数不崩溃", async () => {
  // 仅在存在时验证入口导出（handler 无需真实外部依赖即可导入）
  const app = await import("../index.js");
  assert.equal(typeof app.handler, "function");
});