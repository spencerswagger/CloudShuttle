// frontend/src/api/pipeline.js
import { client } from "./client.js";
export const fetchPipelines = () => client.get("/pipelines");
export const getPipeline = (id) => client.get(`/pipelines/${id}`, { silent: true });
export const createPipeline = (d) => client.post("/pipelines", d);
export const updatePipeline = (id, d) => client.put(`/pipelines/${id}`, d);
export const deletePipeline = (id) => client.delete(`/pipelines/${id}`);
export const runPipeline = (id, body) => client.post(`/pipelines/${id}/run`, body);
// Webhook 触发地址与密钥一律由后端生成下发，前端不再本地拼接：
//   GET  /pipelines/:id/webhook-secret        → { ok, id, name, secret, url }
//   POST /pipelines/:id/webhook-secret/reset  → 同上（轮换密钥并回新的完整地址）
//   GET  /pipelines/:id/webhook-probe         → { ok, body, receivedAt, httpStatus }
//     httpStatus：200 触发成功 / 401 密钥不匹配 / 503 密钥未配置 / null 历史数据
// 后端未部署新版接口时请求 404，由调用方降级为「保存并更新部署后获取触发地址」占位。
const normalizeHookPayload = (d, id) => ({
  id: d?.id ?? id,
  name: d?.name ?? "",
  secret: d?.secret ?? "",
  // 后端未配 base 时可能返回站点相对路径，补上 origin 保证可直接填进 GitHub/GitLab
  url: typeof d?.url === "string" && d.url ? (d.url.startsWith("/") ? location.origin + d.url : d.url) : "",
});

export const getPipelineHook = async (id) =>
  normalizeHookPayload(await client.get(`/pipelines/${id}/webhook-secret`, { silent: true }), id);

export const resetWebhookSecret = async (id) =>
  normalizeHookPayload(await client.post(`/pipelines/${id}/webhook-secret/reset`, {}, { silent: true }), id);

// 调试接收探针：鉴权失败的投递后端同样记录（含 httpStatus），故轮询保持静默、失败不打扰用户
export const fetchWebhookProbe = (id) => client.get(`/pipelines/${id}/webhook-probe`, { silent: true });