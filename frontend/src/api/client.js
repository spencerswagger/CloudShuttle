// frontend/src/api/client.js
import axios from "axios";
export const client = axios.create({
  // baseURL 部署时可改：见 /cloudshuttle-config.js（默认同源 /api，经 nginx 反代；
  // 云端 CDN 无反代时把 apiBase 指向控制面完整地址）
  baseURL: window.CloudShuttleConfig?.apiBase ?? "/api",
});
client.interceptors.response.use((r) => r.data, (e) => Promise.reject(e.response?.data ?? e));