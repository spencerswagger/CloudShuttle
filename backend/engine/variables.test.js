// backend/engine/variables.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { render, parseDeps, parseOutput, globalKeysOf, resolveScope, collectNodeDeps, checkVars } from "./variables.js";
import { buildGraph, ancestors } from "./dag.js";

// ---------- 任务一：渲染器 render + 依赖提取 parseDeps ----------
test("render 替换 ${name} 为 map 值", () => {
  const env = new Map([["branch", "main"], ["app", "cart"]]);
  assert.equal(render("branch=${branch} app=${app}", env), "branch=main app=cart");
});
test("render 未命中的 key 原样保留", () => {
  assert.equal(render("x=${missing}", new Map()), "x=${missing}");
});
test("render 不解析未闭合或非法名", () => {
  const env = new Map();
  assert.equal(render("a=${} b=${1x}", env), "a=${} b=${1x}");
});
test("parseDeps 提取所有 ${name} 的 key", () => {
  assert.deepEqual(parseDeps("${git_ref}//${pipeline_name}"), ["git_ref", "pipeline_name"]);
});

// ---------- 任务二：K=V 输出解析器 parseOutput ----------
test("parseOutput 解析 K=V 行", () => {
  const text = "branch=main\nflag=true\n\n# 注释行不解析\nversion=1.2";
  assert.deepEqual(parseOutput(text), { branch: "main", flag: "true", version: "1.2" });
});
test("parseOutput 忽略空行与注释行", () => {
  assert.deepEqual(parseOutput("  \n# comment\nk=v"), { k: "v" });
});
test("parseOutput 无等号时以冒号分隔", () => {
  assert.deepEqual(parseOutput("a:1\nb:2:3"), { a: "1", b: "2:3" });
});

// ---------- 任务B：静态作用域与保存校验 ----------
test("globalKeysOf 收集执行元信息与触发源 key", () => {
  const spec = { trigger: { manual: { params: [{ key: "branch" }] }, webhook: { mappings: [{ name: "git_ref" }] } } };
  const k = globalKeysOf(spec);
  assert.ok(k.includes("pipeline_name"));
  assert.ok(k.includes("branch"));
  assert.ok(k.includes("git_ref"));
});

test("resolveScope 返回全局key 与 前驱输出key 的并集", () => {
  const graph = buildGraph({ nodes: [
    { id: "n1", type: "shell", params: { outputs: [{ key: "out1" }] } },
    { id: "n2", type: "shell" },
  ], edges: [{ from: "n1", to: "n2" }] });
  const scope = resolveScope(graph, { globalKeys: [] }, ancestors, "n2");
  assert.ok(scope.has("out1"));
});

test("collectNodeDeps 汇总节点所有字符串参数的依赖", () => {
  const nd = { id: "n1", params: { command: "echo ${a}", env: [{ k: "X", v: "${b}" }] } };
  assert.deepEqual([...collectNodeDeps(nd)].sort(), ["a", "b"]);
});

test("checkVars 引用未知key 报错", () => {
  const spec = { nodes: [{ id: "n1", type: "shell", params: { command: "echo ${nope}" } }], edges: [] };
  const err = checkVars(spec, { ancestors });
  assert.ok(err && err.includes("nope") && err.includes("n1"));
});

test("checkVars 引用合法前驱输出 不报错", () => {
  const spec = { nodes: [
    { id: "n1", type: "shell", params: { outputs: [{ key: "branch" }], command: "x=${branch}" } },
    { id: "n2", type: "shell", params: { command: "echo ${branch}" } },
  ], edges: [{ from: "n1", to: "n2" }] };
  assert.equal(checkVars(spec, { ancestors }), null);
});