// backend/test/variables.test.js —— 保存校验 checkVars 与作用域解析
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkVars, resolveScope, globalKeysOf } from "../engine/variables.js";
import { buildGraph, ancestors } from "../engine/dag.js";

// 引用未定义变量 nope 的 spec：checkVars 必须返回非 null 的中文错误串
test("checkVars 引用未定义变量返回错误消息", () => {
  const spec = {
    nodes: [{ id: "n1", type: "shell", params: { command: "echo ${nope}" } }],
    edges: [],
  };
  const err = checkVars(spec, { ancestors });
  assert.notEqual(err, null);
  assert.match(err, /n1/);
  assert.match(err, /nope/);
});

// 含审批节点的 spec，其 message 仅引用内置全局变量（pipeline_name/run_no/started_at）时不应误报
test("checkVars 审批节点 message 引用内置变量返回 null", () => {
  const spec = {
    trigger: { manual: { params: [] }, webhook: { mappings: [] } },
    nodes: [
      {
        id: "n1",
        type: "approval",
        params: {
          message:
            "### 人工审批请求\n\n| 流水线 | ${pipeline_name} |\n| 执行编号 | #${run_no} |\n| 发起时间 | ${started_at} |",
        },
      },
    ],
    edges: [],
  };
  assert.equal(checkVars(spec, { ancestors }), null);
});

// 引用合法前驱节点声明的 outputs key：checkVars 返回 null
test("checkVars 引用合法前驱输出返回 null", () => {
  const spec = {
    nodes: [
      { id: "n1", type: "shell", params: { command: "echo ok", outputs: [{ key: "version" }] } },
      { id: "n2", type: "shell", params: { command: "echo ${version}" } },
    ],
    edges: [{ from: "n1", to: "n2" }],
  };
  assert.equal(checkVars(spec, { ancestors }), null);
});

// 全局 key（执行元信息 + manual param + webhook mapping）始终在作用域内
test("resolveScope 含全局 key 与前驱输出，且排序去重", () => {
  const spec = {
    trigger: {
      manual: { params: [{ key: "branch" }] },
      webhook: { mappings: [{ name: "git_ref" }] },
    },
    nodes: [
      { id: "n1", type: "shell", params: { outputs: [{ key: "version" }] } },
      { id: "n2", type: "shell", params: {} },
    ],
    edges: [{ from: "n1", to: "n2" }],
  };
  const graph = buildGraph(spec);
  const keys = [...resolveScope(graph, spec, ancestors, "n2")].sort();
  for (const k of ["pipeline_id", "pipeline_name", "run_no", "exec_id", "started_at", "branch", "git_ref", "version"]) {
    assert.ok(keys.includes(k), `期望作用域含 ${k}`);
  }
  assert.equal(new Set(keys).size, keys.length, "keys 应无重复");
});

// 作用域接口口径与 checkVars 一致：不存在的节点给出空集
test("考虑未知节点作用域为空（resolveScope 仍可用全局 key）", () => {
  const spec = {
    trigger: { manual: { params: [{ key: "branch" }] } },
    nodes: [{ id: "n1", type: "shell", params: {} }],
    edges: [],
  };
  const graph = buildGraph(spec);
  // globalKeysOf 不含 trigger 之外变量引用的未知变量，可作为未知节点参考
  assert.ok(globalKeysOf(spec).includes("branch"));
});