// backend/engine/trigger.js
// 触发器变量提取：manual 与 webhook 共用一份 params（变量对齐、只配一遍），
// webhook 触发时按每项的 jsonPath 从请求 body 抽取，取不到回退 default；
// manual 触发时从提交表单取值，缺失回退 default。均不抛错：命中不到/取值空/
// 异常 json 一律静默跳过，绝不中断触发流程。

import { JSONPath } from "jsonpath-plus";
import { triggerParamsOf } from "./variables.js";

/**
 * 从 webhook 请求体 body 按 mappings 抽取变量写入 env（独立 API，保留兼容）。
 * @param {Array<{name?:string, jsonPath?:string}>} mappings
 * @param {unknown} body 已解析的请求体（对象）；字符串/undefined 等非对象静默跳过。
 * @param {Map<string,string>} env
 */
export function extractWebhookVars(mappings, body, env) {
  for (const m of mappings ?? []) {
    if (!m?.name || !m?.jsonPath) continue;
    const value = hitJsonPath(body, m.jsonPath, m.name);
    if (value === undefined || value === null) continue; // 无值不写入
    env.set(m.name, String(value));
  }
}

// 单一 JSONPath 取值：异常与无命中都返回 undefined，仅记日志。
function hitJsonPath(body, jsonPath, label) {
  let hit;
  try {
    hit = JSONPath({ path: jsonPath, json: body, wrap: false });
  } catch (err) {
    console.error(`[trigger] webhook JSONPath 异常 key=${label} jsonPath=${jsonPath}`, err?.message ?? err);
    return undefined;
  }
  // wrap:false 命中数组时多余的容器外层返回数组，取首元素。
  if (Array.isArray(hit)) return hit[0];
  return hit;
}

/**
 * webhook 触发：按统一 params 抽取变量。有 jsonPath 且命中 → 用抽取值；
 * 未配 jsonPath 或命中为空 → 回退 default（与 manual 的缺省语义对齐）。
 * @param {Array<{key?:string, jsonPath?:string, default?:*}>} params
 * @param {unknown} body
 * @param {Map<string,string>} env
 */
export function extractTriggerVarsForWebhook(params, body, env) {
  for (const p of params ?? []) {
    if (!p?.key) continue;
    const hit = p.jsonPath ? hitJsonPath(body, p.jsonPath, p.key) : undefined;
    if (hit !== undefined && hit !== null) {
      env.set(p.key, String(hit));
    } else if (p.default !== undefined && p.default !== null && p.default !== "") {
      env.set(p.key, String(p.default));
    }
  }
}

/**
 * 从 manual 触发器提交的表单 formValue 抽取 params 变量写入 env。
 * 有效值（非空字符串/非 undefined/null）覆盖 default；缺失/空用 default；两者皆无则不写。
 * @param {Array<{key?:string, default?:string|null}>} params
 * @param {Record<string, unknown>|undefined} formValue
 * @param {Map<string,string>} env
 */
export function extractManualVars(params, formValue, env) {
  const form = formValue ?? {};
  for (const p of params ?? []) {
    if (!p?.key) continue;
    const raw = form[p.key];
    if (raw !== undefined && raw !== null && raw !== "") {
      env.set(p.key, String(raw));
    } else if (p.default !== undefined && p.default !== null && p.default !== "") {
      env.set(p.key, String(p.default));
    }
  }
}

/**
 * 把触发源「spec.trigger 配置 → environment Map」的装配提为纯函数（可单测）：
 * 以 initEnv（执行元信息 Map）为基础，按统一 params 叠写触发变量——
 * manual 触发取 formValue，webhook 触发按 jsonPath 抽 body（未命中回退 default）。
 * 旧结构 spec（trigger.manual/webhook 分离）经 triggerParamsOf 合并兜底。
 * @param {object} args
 * @param {object} args.spec 流水线 spec（读 spec.trigger.params，兼容旧结构）
 * @param {Record<string,unknown>|undefined} [args.formValue] manual 表单提交值
 * @param {unknown} [args.webhookBody] webhook 请求体（已解析对象）
 * @param {Map<string,string>|undefined} [args.initEnv] 基础环境（执行元信息等）
 * @returns {Map<string,string>}
 */
export function assembleTriggerEnv({ spec, formValue, webhookBody, initEnv }) {
  const env = new Map(initEnv ?? []);
  const params = triggerParamsOf(spec);
  if (webhookBody !== undefined) extractTriggerVarsForWebhook(params, webhookBody, env);
  if (formValue !== undefined) extractManualVars(params, formValue, env);
  return env;
}