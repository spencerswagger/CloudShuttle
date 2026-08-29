import { test } from "node:test";
import assert from "node:assert/strict";
import { renderApprovalCard } from "./approval.js";

// 模拟执行引擎注入的扁平变量地图（含 globalKeysOf 规定的执行元信息变量）
function envWithMeta() {
  const env = new Map();
  env.set("pipeline_id", "42");
  env.set("pipeline_name", "demo-pipeline");
  env.set("run_no", "7");
  env.set("exec_id", "1001");
  env.set("started_at", "2026-08-29 12:00");
  return env;
}

test("空 body：默认模板能被 environment 填充 ${pipeline_name} 等变量", () => {
  const md = renderApprovalCard({ body: "", env: envWithMeta() });
  assert.ok(md.includes("demo-pipeline"), "pipeline_name 应被替换");
  assert.ok(md.includes("7"), "run_no=7 应被填充");
  assert.ok(md.includes("1001"), "exec_id 应被填充");
  assert.ok(md.includes("42"), "pipeline_id 应被填充");
  assert.ok(md.includes("2026-08-29 12:00"), "started_at 应被填充");
  assert.ok(!md.includes("${"), "填充后不应残留未处理占位符");
});

test("空 body + 未提供某变量：对应 ${name} 原样保留便于发现问题", () => {
  const env = new Map();
  env.set("pipeline_name", "demo");
  const md = renderApprovalCard({ body: "", env });
  assert.ok(md.includes("demo"));
  assert.ok(md.includes("${run_no}"), "缺失的 run_no 占位符原样保留");
  assert.ok(md.includes("${started_at}"), "缺失的 started_at 占位符原样保留");
});

test("非空 body：所见即所得，直接输出且不再套默认模板", () => {
  const md = renderApprovalCard({ body: "请审批部署批次 #3", env: envWithMeta() });
  assert.equal(md, "请审批部署批次 #3");
});

test("非空 body 保留原有 ${} 引用（调用方已渲染，本层不再渲染）", () => {
  // 执行引擎 advanceOnce 已用 renderParams 深渲染 params，故 body 到本层时已是最新文本；
  // 本纯函数只透传，不二次渲染。
  const md = renderApprovalCard({ body: "版本 ${image} 待审核", env: envWithMeta() });
  assert.equal(md, "版本 ${image} 待审核");
});

test("空 body 且 environment 为普通对象也能规整为 Map 使用", () => {
  const md = renderApprovalCard({
    body: "",
    env: { pipeline_name: "obj-pipeline", pipeline_id: "6", run_no: "9", exec_id: "5", started_at: "t" },
  });
  assert.ok(md.includes("obj-pipeline"));
  assert.ok(md.includes("9"));
  assert.ok(!md.includes("${"), "对象源规整后占位符应被填充");
});

test("默认模板结构回归：含标题且不残留旧 {{ }} 占位符风格", () => {
  const md = renderApprovalCard({ body: "", env: envWithMeta() });
  assert.ok(md.startsWith("### ✦ 流水线审批卡点"));
  assert.ok(md.includes("**流水线**"), "默认模板应含流水线表格行");
  assert.ok(!md.includes("{{"), "默认模板不应残留旧 {{ }} 占位符风格");
});