// backend/engine/variables.js
// 变量机制：模板渲染 / env 依赖提取 / 节点输出 K=V 解析 / 静态作用域与保存校验。

import { buildGraph, ancestors } from "./dag.js";

const RE = /\$\{([A-Za-z][A-Za-z0-9_.]*)\}/g;

/**
 * 提取文本中所有 ${name} 的 name 列表（按出现顺序，可能重复）。
 * @param {string} text
 * @returns {string[]}
 */
export function parseDeps(text) {
  const deps = [];
  for (const m of String(text).matchAll(RE)) deps.push(m[1]);
  return deps;
}

/**
 * 渲染模板。把 ${name} 替换为 env.get(name)。
 * 键不存在/值为 undefined 时原样保留 ${name}，绝不抛错。
 * @param {string} text
 * @param {Map<string,string>} env
 * @returns {string}
 */
export function render(text, env) {
  return String(text).replace(RE, (whole, name) => {
    const v = env.get(name);
    return v === undefined ? whole : v;
  });
}

/**
 * 解析 GITHUB_OUTPUT 简化风格的 K=V 输出。
 * 逐行：跳过空行、# 注释行、:: 开头的 dotenv 命令行。
 * 分隔符优先 =，否则 :（容错）。键值均 trim，value 不去引号。
 * @param {string} text
 * @returns {Record<string,string>}
 */
export function parseOutput(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue; // 空行
    if (line.startsWith("#") || line.startsWith("::")) continue; // 注释 / dotenv 命令
    let sepIdx = line.indexOf("=");
    if (sepIdx === -1) sepIdx = line.indexOf(":"); // 无等号时冒号容错
    if (sepIdx === -1) continue; // 无合法分隔符，跳过
    const key = line.slice(0, sepIdx).trim();
    const value = line.slice(sepIdx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * 触发源全局 key：执行元信息 + manual.params[](key) + webhook.mappings[](name)。
 * @param {object} spec
 * @returns {string[]}
 */
export function globalKeysOf(spec) {
  const keys = ["pipeline_id", "pipeline_name", "run_no", "exec_id", "started_at"];
  for (const p of spec?.trigger?.manual?.params ?? []) {
    if (p?.key) keys.push(p.key);
  }
  for (const m of spec?.trigger?.webhook?.mappings ?? []) {
    if (m?.name) keys.push(m.name);
  }
  return keys;
}

/**
 * 某节点静态可用变量集：全局 key ∪ 所有前驱节点（ancestors）在 outputs 里声明的 key。
 * @param {object} graph buildGraph 的产物
 * @param {object} spec
 * @param {Function} ancestorsFn dag.js 的 ancestors
 * @param {string} nodeId
 * @returns {Set<string>}
 */
export function resolveScope(graph, spec, ancestorsFn, nodeId) {
  const scope = new Set(globalKeysOf(spec));
  for (const ancId of ancestorsFn(graph, nodeId)) {
    const node = graph.nodes.get(ancId);
    for (const o of node?.params?.outputs ?? []) {
      if (o?.key) scope.add(o.key);
    }
  }
  return scope;
}

/**
 * 汇总节点所有字符串参数中的 ${name} 依赖 key（跳过 outputs 声明）。
 * 覆盖 command/message 等字符串字段，以及 env 数组元素对象的 v/value 字段。
 * @param {{params: object}} node
 * @returns {Set<string>}
 */
export function collectNodeDeps(node) {
  const deps = new Set();
  const addText = (text) => {
    if (typeof text !== "string") return;
    for (const d of parseDeps(text)) deps.add(d);
  };
  const walk = (value, skipKeys) => {
    if (typeof value === "string") { addText(value); return; }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, new Set());
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (skipKeys.has(k)) continue;
        walk(v, skipKeys);
      }
    }
  };
  walk(node.params, new Set(["outputs"]));
  return deps;
}

/**
 * 保存校验：每个节点引用的依赖必须落在自身静态作用域内。
 * 对每个节点用 collectNodeDeps 求依赖、resolveScope 求可用集；未命中返回错误消息，全部通过返回 null。
 * @param {object} spec
 * @param {{Function: Function}} _opts 占位参数（键为 ancestors，用于将来注入自定义闭包）
 * @returns {string|null}
 */
export function checkVars(spec, { ancestors: _ancestors } = {}) {
  const graph = buildGraph(spec);
  for (const node of spec?.nodes ?? []) {
    const deps = collectNodeDeps(node);
    if (deps.size === 0) continue;
    const scope = resolveScope(graph, spec, _ancestors ?? ancestors, node.id);
    for (const dep of deps) {
      if (!scope.has(dep)) return `节点 ${node.id} 引用了未定义变量 ${dep}`;
    }
  }
  return null;
}