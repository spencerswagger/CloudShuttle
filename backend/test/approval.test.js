// backend/test/approval.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApprovalStep } from "../steps/approval.js";
import { createDingtalkProvider } from "../providers/dingtalk.js";

test("approval step 用机器人发审批卡片并登记 wait", async () => {
  let url, payload;
  const dingtalkProvider = createDingtalkProvider({
    httpClient: { post: async (u, b) => { url = u; payload = b; return {}; } },
    getCredentialSecrets: async () => ({ webhook: "https://oapi.dingtalk.com/robot/send?access_token=abc" }),
  });
  const step = makeApprovalStep({ dingtalkProvider, genToken: () => "tok-x", controlPlaneBase: "https://cp" });
  const ctx = { execId: 5, recordRegistry: async () => {} };
  const node = { id: "n2", type: "approval", params: { robot: "demo-robot", approverUid: "u1", message: "发布?" } };
  const out = await step(node, ctx);
  assert.equal(out.kind, "wait");
  assert.ok(url.includes("access_token=abc"));
  assert.equal(payload.msgtype, "markdown");
  assert.ok(payload.markdown.text.includes("/hook/dingtalk/tok-x?execId=5&nodeId=n2"));
  assert.ok(payload.markdown.text.includes("decision=approve"));
  assert.ok(payload.markdown.text.includes("decision=reject"));
});

test("approval 缺 robot 抛错", async () => {
  const dingtalkProvider = createDingtalkProvider({
    httpClient: { post: async () => ({}) },
    getCredentialSecrets: async () => ({ webhook: "https://x" }),
  });
  const step = makeApprovalStep({ dingtalkProvider, genToken: () => "t", controlPlaneBase: "https://cp" });
  await assert.rejects(
    () => step({ id: "n2", type: "approval", params: {} }, { execId: 1, recordRegistry: async () => {} }),
    /robot/
  );
});

test("决策归一 approve / reject", () => {
  const p = createDingtalkProvider({});
  assert.equal(p.normalizeDecision("approve"), "approve");
  assert.equal(p.normalizeDecision("reject"), "reject");
  assert.equal(p.normalizeDecision("whatever"), "approve");
});