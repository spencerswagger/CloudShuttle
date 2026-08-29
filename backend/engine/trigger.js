// backend/engine/trigger.js
// 触发器变量提取：webhook 用 JSONPath 从请求 body 抽取，manual 从提交表单取值。
// 二者都不抛错：命中不到/取值为空/异常 json 一律静默跳过，绝不中断触发流程。

import { JSONPath } from "jsonpath-plus";

/**
 * 从 webhook 请求体 body 按 mappings 抽取变量写入 env。
 * @param {Array<{name?:string, jsonPath?:string}>} mappings
 * @param {unknown} body 已解析的请求体（对象）；字符串/undefined 等非对象静默跳过。
 * @param {Map<string,string>} env
 */
export function extractWebhookVars(mappings, body, env) {
  for (const m of mappings ?? []) {
    if (!m?.name || !m?.jsonPath) continue;
    let hit;
    try {
      hit = JSONPath({ path: m.jsonPath, json: body, wrap: false });
    } catch (err) {
      console.error(`[trigger] webhook JSONPath 异常 jsonPath=${m.jsonPath}`, err?.message ?? err);
      continue;
    }
    let value = hit;
    // wrap:false 命中数组时多余的容器外层返回数组，取首元素。
    if (Array.isArray(hit)) value = hit[0];
    if (value === undefined || value === null) continue; // 无值不写入
    env.set(m.name, String(value));
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
 * 以 initEnv（执行元信息 Map）为基础，再按 spec.trigger 配置把 manual formValue 与
 * webhook body 提取的变量叠写上去。manual 与 webhook 两者的配置/取值均可选；
 * 哪个触发器提供配置就抽取哪个，缺省/无值一律静默跳过（沿用 extract* 的不抛语义）。
 * @param {object} args
 * @param {object} args.spec 流水线 spec（取 spec.trigger.manual / spec.trigger.webhook）
 * @param {Record<string,unknown>|undefined} [args.formValue] manual 表单提交值
 * @param {unknown} [args.webhookBody] webhook 请求体（已解析对象）
 * @param {Map<string,string>|undefined} [args.initEnv] 基础环境（执行元信息等）
 * @returns {Map<string,string>}
 */
export function assembleTriggerEnv({ spec, formValue, webhookBody, initEnv }) {
  const env = new Map(initEnv ?? []);
  extractWebhookVars(spec?.trigger?.webhook?.mappings, webhookBody, env);
  extractManualVars(spec?.trigger?.manual?.params, formValue, env);
  return env;
}