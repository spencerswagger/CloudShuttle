// 凭证类型元数据（列表页与表单页共用）
export const CRED_KINDS = [
  {
    value: "dingtalk-corp",
    label: "钉钉企业机器人",
    icon: "M6 3h12v18H6zM9.5 8h5M9.5 12h5M9.5 16h3",
    hint: "走钉钉企业应用 OpenAPI，审批仅发人（机器人单聊互动卡片），需配置下方卡片模板 ID 与回调 routeKey",
    fields: [
      { k: "appKey", label: "AppKey", ph: "应用 AppKey" },
      { k: "appSecret", label: "AppSecret", ph: "应用 AppSecret", secret: true },
      { k: "agentId", label: "AgentId", ph: "应用 AgentId" },
      { k: "robotCode", label: "RobotCode", ph: "机器人编码" },
      { k: "cardTemplateId", label: "卡片模板 ID", ph: "卡片平台中模板的 templateId", hint: "发群审查的「卡片平台」模板 ID" },
      { k: "cardCallbackRouteKey", label: "回调 routeKey", ph: "开发者后台注册卡片回调地址后的 routeKey", hint: "模板按钮「回传请求」回调路由标识" },
    ],
  },
  {
    value: "docker-registry",
    label: "Docker 私有仓库",
    icon: "M20 7a4 4 0 0 1-6 3.5L9 15a4 4 0 1 1-2.8-2.3L11.4 8A4 4 0 1 1 20 7zM3.5 17.5L7 21M5 19.5l-1.5-1.5",
    hint: "供 shell 节点拉取私有镜像时使用",
    fields: [
      { k: "registry", label: "仓库地址", ph: "registry.example.com" },
      { k: "username", label: "账号", ph: "账号" },
      { k: "password", label: "密码 / Token", ph: "密码", secret: true },
    ],
  },
  {
    value: "s3",
    label: "S3 兼容对象存储",
    icon: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zm-6 5l6 3.5 6-3.5M12 11.5V21",
    hint: "可用于产物归档与静态资源托管",
    fields: [
      { k: "endpoint", label: "Endpoint", ph: "oss-cn-hangzhou.aliyuncs.com" },
      { k: "bucket", label: "Bucket", ph: "bucket" },
      { k: "ak", label: "AccessKey", ph: "AK" },
      { k: "sk", label: "SecretKey", ph: "SK", secret: true },
    ],
  },
];
export const credKind = (v) => CRED_KINDS.find((k) => k.value === v);
export const credKindLabel = (v) => credKind(v)?.label ?? v;