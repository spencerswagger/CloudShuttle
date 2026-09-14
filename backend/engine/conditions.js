// 边条件求值：JSONPath 从条件上下文树取值 + 比较运算符。
// 条件上下文树：{ trigger, outputs, env }，供 branch 出边条件与 loop items 取数共用。
import { JSONPath } from "jsonpath-plus";

const OPS = {
  eq: (a, b) => a == b,
  ne: (a, b) => a != b,
  gt: (a, b) => Number(a) > Number(b),
  ge: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  le: (a, b) => Number(a) <= Number(b),
  contains: (a, b) => String(a ?? "").includes(String(b)),
  starts_with: (a, b) => String(a ?? "").startsWith(String(b)),
  ends_with: (a, b) => String(a ?? "").endsWith(String(b)),
  exists: (a) => a !== undefined && a !== null,
  empty: (a) => a === undefined || a === null || a === "" || (Array.isArray(a) && a.length === 0),
  regex: (a, b) => {
    try { return new RegExp(String(b)).test(String(a ?? "")); }
    catch { return false; }
  },
};

export const COND_OPS = Object.keys(OPS);

/**
 * 对条件上下文树求值一条边条件。
 * op/path 校验失败、JSONPath 抛异常、正则编译失败等一律返回 false 且不抛错；
 * 对 jsonpath-plus 宽松容忍的畸形路径（如 "$..["、 "$.["），按其宽松求值结果判断。
 * @param {{path?:string, op?:string, val?:*} | null | undefined} cond
 * @param {object} ctx 条件上下文树（buildCondCtx 产物）
 * @returns {boolean}
 */
export function evalCond(cond, ctx) {
  if (!cond || typeof cond !== "object") return false;
  const { path, op, val } = cond;
  if (typeof path !== "string" || !path.trim() || !Object.hasOwn(OPS, op)) return false;
  let hit;
  try { hit = JSONPath({ path, json: ctx, wrap: false }); }
  catch { return false; }
  // 命中结果可能是数组（含宽松求值返回整棵树的情形），统一取首元素作为比较值（与 trigger.js 的 hitJsonPath 对齐）
  if (Array.isArray(hit)) hit = hit[0];
  return OPS[op](hit, val);
}

/**
 * 构造条件上下文树。
 * @param {{triggerRaw?: unknown, nodeOutputs?: Record<string, object>, env?: Record<string, string>}} parts
 * @returns {{trigger: unknown, outputs: Record<string, object>, env: Record<string, string>}}
 */
export function buildCondCtx({ triggerRaw, nodeOutputs, env } = {}) {
  return { trigger: triggerRaw ?? null, outputs: nodeOutputs ?? {}, env: env ?? {} };
}
