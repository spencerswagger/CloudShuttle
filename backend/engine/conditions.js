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
 * 对条件上下文树求值一条边条件。任何异常/非法输入一律返回 false，绝不抛错。
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
  // wrap:false 命中数组时多余的容器外层返回数组，取首元素（与 trigger.js 的 hitJsonPath 对齐）
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
