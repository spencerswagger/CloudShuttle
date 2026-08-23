# 通用「控制面」镜像：同一个 backend/ 同时服务 FC 与 SAE（以及 docker-compose）
#   - docker-compose / 本机：entrypoint 先迁移+seed，再起 local-server.js 监听 HTTP
#   - SAE Web：镜像部署同一镜像，容器内起 local-server.js（HTTP 进程）；如需加快冷启动
#     可设 SKIP_BOOTSTRAP=1，改由部署时/CI 手动执行 migrate+seed
#   - FC：函数代码模式用 backend/index.js 的 handler，不打包镜像；若走 FC「自定义容器」跑本镜像，
#     必须设 SKIP_BOOTSTRAP=1（否则 entrypoint 卡在 waiting for postgres，探活 9000 超时被回收）
# 端口：SAE 健康检查用 /healthz；应用入口由后端 routeToHandler 按 path 分发
FROM node:20-alpine
RUN apk add --no-cache postgresql-client

WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/ ./
COPY deploy/seed.sql ./deploy/seed.sql
COPY backend/docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 9000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]