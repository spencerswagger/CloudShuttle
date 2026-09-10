// frontend/src/lib/webhookDraft.js
// Webhook 请求体 → JSONPath 映射草案（纯函数，供编辑页「调试接收」一键生成使用）
//
// 规则（深度 ≤ 2，即最深到 $.a.b）：
//   标量            → $.a、$.a.b（值为 null 的字段跳过：后端对 null 不注入，避免运行时永不替换的死映射）
//   数组            → $.a[0]（取首元素）；首元素为对象时展开其标量子字段 → $.a[0].b
//   对象再套对象    → 只下探一层（$.a.b），更深的分支忽略
// name = 路径段以 _ 连接后 sanitize：非 [A-Za-z0-9_] → _，开头非字母补 v_ 前缀；
// sanitize 后无 ASCII 字母（如纯中文键）用 f_<序号> 兜底；与内置执行元信息同名跳过（不可被覆盖）；
// 结果撞名追加 _2/_3 后缀而非丢弃。

const IDENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/; // 可安全写成 $.key 的对象键
const DEFAULT_MAX = 40;                       // 单次最多产出的草案条数
// 内置执行元信息：触发映射不得覆盖（后端 assembleTriggerEnv 会叠写在 initEnv 之上）
const RESERVED = new Set(["pipeline_id", "pipeline_name", "run_no", "exec_id", "started_at"]);

const isScalar = (v) => ["string", "number", "boolean"].includes(typeof v);
const isPlainObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// 对象键访问器：合法标识符走点号，其余（含中划线、点、空格、数字开头）用引号方括号，保证 JSONPath 可解析
const keyAccessor = (k) => (IDENT_KEY.test(k) ? `.${k}` : `[${JSON.stringify(String(k))}]`);

// 路径段 → 变量名；无 ASCII 字母可用时返回空串，由调用方兜底数字命名
export function sanitizeVarName(segments) {
  const raw = (segments ?? []).map((s) => String(s).replace(/[^A-Za-z0-9_]/g, "_")).join("_");
  if (!raw || !/[A-Za-z]/.test(raw)) return "";
  return /^[A-Za-z]/.test(raw) ? raw : `v_${raw}`;
}

/**
 * 遍历 webhook 请求体产出映射草案。
 * @param {unknown} body 探针返回的请求体（非对象/数组返回空数组）
 * @param {{max?: number}} [opts] max：最多条数，默认 40
 * @returns {Array<{name: string, jsonPath: string}>}
 */
export function buildMappingDraft(body, { max = DEFAULT_MAX } = {}) {
  const out = [];
  const used = new Set();
  let anonSeq = 0;
  const add = (jsonPath, segments) => {
    if (out.length >= max) return;
    let name = sanitizeVarName(segments);
    if (!name) name = `f_${++anonSeq}`;       // 纯中文等不可转写键：数字兜底，jsonPath 仍指向真实路径
    if (RESERVED.has(name)) return;           // 内置元信息不可被 webhook 映射覆盖
    if (used.has(name)) {                     // sanitize 撞名：追加序号而非丢弃
      let i = 2;
      while (used.has(`${name}_${i}`)) i++;
      name = `${name}_${i}`;
    }
    used.add(name);
    out.push({ name, jsonPath });
  };

  // 数组：整体命中首元素 $.a[0]；首元素为对象时展开其标量子字段 $.a[0].b
  const walkArray = (arr, path, segments) => {
    add(`${path}[0]`, segments);
    const first = arr?.[0];
    if (!isPlainObj(first)) return;
    for (const [k, v] of Object.entries(first)) {
      if (isScalar(v)) add(`${path}[0]${keyAccessor(k)}`, [...segments, k]);
    }
  };

  // depth 为当前对象所在层级（根对象 0）；只在 depth < 2 时展开，故最深到 $.a.b
  const walkObj = (obj, path, segments, depth) => {
    if (depth >= 2 || out.length >= max) return;
    for (const [k, v] of Object.entries(obj)) {
      const p = `${path}${keyAccessor(k)}`;
      const ks = [...segments, k];
      if (isScalar(v)) add(p, ks);
      else if (Array.isArray(v)) walkArray(v, p, ks);
      else if (isPlainObj(v)) walkObj(v, p, ks, depth + 1);
      // 其余（如 undefined）忽略
    }
  };

  if (isPlainObj(body)) walkObj(body, "$", [], 0);
  else if (Array.isArray(body)) walkArray(body, "$", ["item"]);
  return out;
}
