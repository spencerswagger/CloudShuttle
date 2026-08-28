// frontend/src/api/client.js
import axios from "axios";
import { notify } from "../lib/notify.js";
import { pending } from "../lib/busy.js";

// baseURL 优先级：
//   开发模式(dev)  -> 仅读取 .env.development 的 VITE_API_BASE（该文件已被 .gitignore 忽略，不会提交）
//   生产模式       -> 读取 public/cloudshuttle-config.js 的 window.CloudShuttleConfig.apiBase（部署时改）
//   兜底           -> 同源 /api（docker-compose / nginx 反代）
// dev 下 VITE_API_BASE 留空时走 vite.config.js 里的代理（/api → http://localhost:9000），避免跨源。
const apiBase =
  (import.meta.env.DEV ? import.meta.env.VITE_API_BASE : undefined) ||
  window.CloudShuttleConfig?.apiBase ||
  "/api";

export const client = axios.create({ baseURL: apiBase });
// 请求发起与结束统一增减在途计数，驱动全局顶部进度条
client.interceptors.request.use(
  (cfg) => { pending.value++; return cfg; },
  (e) => { pending.value = Math.max(0, pending.value - 1); return Promise.reject(e); }
);
client.interceptors.response.use(
  (r) => {
    pending.value = Math.max(0, pending.value - 1);
    return r.data;
  },
  (e) => {
    pending.value = Math.max(0, pending.value - 1);
    // 统一把后端错误归一化并弹出可复制的 requestId 提示
    // silent=true 的请求（如详情探测回退）不弹全局吐司，由调用方自理
    const cfg = e?.config || {};
    const data = e?.response?.data;
    const isApi = data && typeof data === "object" && data.ok === false;
    const message = (isApi && data.message) || "请求失败，请稍后再试";
    const requestId = (isApi && data.requestId) || e?.response?.headers?.["x-request-id"] || "";
    if (!cfg.silent) notify({ type: "error", message, requestId });
    return Promise.reject({ status: e?.response?.status, message, requestId, data });
  }
);