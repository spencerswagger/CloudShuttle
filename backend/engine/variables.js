// backend/engine/variables.js
// 变量机制：模板渲染 / env 依赖提取 / 节点输出 K=V 解析。

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