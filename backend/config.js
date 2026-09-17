export const config = {
  pg: {
    host: process.env.PG_HOST ?? "localhost",
    port: Number(process.env.PG_PORT ?? 5432),
    database: process.env.PG_DB ?? "cloudshuttle",
    user: process.env.PG_USER ?? "cloudshuttle",
    password: process.env.PG_PASSWORD ?? "cloudshuttle",
  },
  redis: { url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379" },
  // 仅当使用凭证库（secret 落库）时才必须配置；留空则禁止创建凭证。
  sm4Key: process.env.SM4_KEY ?? "",
  // 回调用绝对地址；可显式配置（覆盖），留空则从请求 Host 自动推导。
  controlPlaneBase: process.env.CONTROL_BASE ?? "",
  // 内网回调地址前缀（可选）：配置后容器内回调走该前缀（如 http://<FC内网>/，
  // 集群与控制面同 VPC 时可达）；未配置仍使用外网地址（controlPlaneBase/请求 Host 推导）。
  callbackBaseInternal: process.env.CALLBACK_BASE_INTERNAL ?? "",
};