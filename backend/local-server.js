// backend/local-server.js —— 本地承载 FC handler 的极薄 HTTP 服务
// 用法：cd backend && node local-server.js   （默认监听 :9000）
// 把 req 组装成 FC 事件对象 { path, httpMethod, body } 后调用 index.js 的 handler。
import { createServer } from "node:http";
import { handler } from "./index.js";
import { getBuild } from "./version.js";

const PORT = Number(process.env.PORT ?? 9000);
const BUILD = getBuild();

console.log(`cloudshuttle-backend build=${BUILD} starting on :${PORT}`);

const server = createServer(async (req, res) => {
  // 健康检查探针（SAE liveness/readiness 用）
  if (/^\/healthz/.test(req.url ?? "")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = null;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw) {
    try { body = JSON.parse(raw); } catch { body = raw; }
  }

  const event = {
    httpMethod: req.method,
    path: req.url,
    headers: req.headers,
    body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
  };

  try {
    const out = await handler(event);
    res.writeHead(out.statusCode ?? 200, { ...out.headers, "content-type": "application/json" });
    res.end(out.body);
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, code: "INTERNAL_ERROR", message: "服务暂时不可用，请稍后再试" }));
  }
});

server.listen(PORT, () => {
  console.log(`control plane local server on http://localhost:${PORT}`);
});