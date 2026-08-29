// 凭证类型元数据（列表页与表单页共用）
export const CRED_KINDS = [
  {
    value: "dingtalk-corp",
    label: "钉钉企业机器人",
    icon: "M6 3h12v18H6zM9.5 8h5M9.5 12h5M9.5 16h3",
    hint: "走钉钉企业应用 OpenAPI，审批以单聊互动卡片发送。保存时将自动校验配置并在后端注册回调，无需手动填写 RouteKey。",
    // 用户在钉钉后台需完成的配置步骤与跳转入口
    guide: [
      { title: "创建企业内部应用 · 取 AppKey/AppSecret", text: "登录开发者后台，应用详情 → 基础信息 → 凭证与基础信息（AppKey 即 Client ID，AppSecret 即 Client Secret）", url: "https://open-dev.dingtalk.com" },
      { title: "开启应用内机器人", text: "应用能力 → 机器人，发布后在企业企业内部应用场景中 RobotCode 即 AppKey，可留空由系统自动带入", url: "https://open-dev.dingtalk.com" },
      { title: "搭建并发布审批卡片模板", text: "在卡片平台搭建含「同意/拒绝」按钮的模板，发布后复制 templateId 填入下方「卡片模板 ID」", url: "https://open-dev.dingtalk.com/fe/card" },
      { title: "申请『互动卡片实例写权限』", text: "开发配置 → 权限管理，搜索并申请 Card.Instance.Write，否则保存校验会失败", url: "https://open-dev.dingtalk.com" },
    ],
    // 由后端自动推导/生成的参数，仅展示说明
    auto: [
      { label: "RobotCode", value: "= 应用 AppKey，无需填写" },
      { label: "回调 RouteKey", value: "保存凭证时由后端自动注册，无需填写" },
    ],
    fields: [
      { k: "appKey", label: "AppKey", ph: "应用 AppKey（即 Client ID）" },
      { k: "appSecret", label: "AppSecret", ph: "应用 AppSecret（即 Client Secret）", secret: true },
      { k: "cardTemplateId", label: "卡片模板 ID", ph: "卡片平台中审批模板的 templateId", hint: "在卡片平台搭建发布后复制" },
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