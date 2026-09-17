// 凭证类型元数据（列表页与表单页共用）
// 阿里云 ECI 常用地域（下拉候选；仍可手动输入其他地域 ID）
export const ECI_REGIONS = [
  { id: "cn-hangzhou", label: "华东1（杭州）" },
  { id: "cn-shanghai", label: "华东2（上海）" },
  { id: "cn-beijing", label: "华北2（北京）" },
  { id: "cn-zhangjiakou", label: "华北3（张家口）" },
  { id: "cn-huhehaote", label: "华北5（呼和浩特）" },
  { id: "cn-qingdao", label: "华北1（青岛）" },
  { id: "cn-shenzhen", label: "华南1（深圳）" },
  { id: "cn-guangzhou", label: "华南2（广州）" },
  { id: "cn-chengdu", label: "西南1（成都）" },
  { id: "cn-hongkong", label: "中国香港" },
  { id: "ap-southeast-1", label: "新加坡" },
  { id: "ap-northeast-1", label: "日本（东京）" },
  { id: "us-west-1", label: "美国（硅谷）" },
  { id: "us-east-1", label: "美国（弗吉尼亚）" },
  { id: "eu-central-1", label: "德国（法兰克福）" },
];
export const CRED_KINDS = [
  {
    value: "eci",
    label: "阿里云 ECI",
    icon: "M12 2l8 4v6a8 8 0 0 1-4.5 7.2L12 21l-3.5-1.8A8 8 0 0 1 4 12V6l8-4zm-2 11l2 2 4-5",
    hint: "仅保存阿里云 AccessKey（AK/SK）。地域、交换机与安全组属运行配置，在流水线 Shell 节点上选择（凭证不绑定地域，可跨地域复用）。",
    guide: [
      { title: "创建 AccessKey", text: "阿里云控制台 → 访问控制 RAM → 用户 → 为该用户建立专属 AK 并授予最小权限", url: "https://ram.console.aliyun.com" },
      { title: "授权 RAM 权限", text: "运行 Shell 节点需 AliyunECIFullAccess（创建/管理 ECI 必需）；在节点上探测交换机/安全组另需 AliyunVPCReadOnlyAccess 与 AliyunECSReadOnlyAccess（或直接授予 AliyunVPCReadOnlyAccess + AliyunECSReadOnlyAccess）。ECI 底层资源由服务关联角色 AliyunServiceRoleForECI 访问，无需手动创建", url: "https://ram.console.aliyun.com" },
      { title: "在 Shell 节点配置地域与网络", text: "创建凭证后，在流水线的 Shell 节点选择该凭证，并配置地域、交换机（VSwitch）与安全组（SecurityGroup）；填写后节点会提示已自动探测到可用网络/规格", url: "https://ecs.console.aliyun.com" },
    ],
    fields: [
      { k: "accessKeyId", label: "AccessKey ID", ph: "阿里云账号的 AccessKey ID", required: true },
      { k: "accessKeySecret", label: "AccessKey Secret", ph: "与 AccessKey ID 配对的 Secret", secret: true, required: true },
    ],
  },
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
  {
    value: "mysql",
    label: "MySQL 数据库",
    icon: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6",
    hint: "数据库连接凭证（SQL 节点后端直连执行）。固定字段见下；其余驱动连接参数（ssl / charset / connectTimeout 等）在「额外连接参数」按需添加，可多条。",
    fields: [
      { k: "host", label: "主机地址", ph: "数据库主机地址", required: true },
      { k: "port", label: "端口", ph: "3306" },
      { k: "user", label: "用户名", ph: "数据库用户名", required: true },
      { k: "password", label: "密码", ph: "数据库密码", secret: true, required: true },
      { k: "database", label: "数据库名", ph: "默认连接的数据库", required: true },
      { k: "extra", type: "kvlist", label: "额外连接参数", hint: "键=值，可添加多条；如 ssl=true / charset=utf8mb4 / connectTimeout=10000" },
    ],
  },
  {
    value: "pg",
    label: "PostgreSQL 数据库",
    icon: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
    hint: "数据库连接凭证（SQL 节点后端直连执行）。固定字段见下；其余驱动连接参数（ssl / application_name / statement_timeout 等）在「额外连接参数」按需添加，可多条。",
    fields: [
      { k: "host", label: "主机地址", ph: "数据库主机地址", required: true },
      { k: "port", label: "端口", ph: "5432" },
      { k: "user", label: "用户名", ph: "postgres", required: true },
      { k: "password", label: "密码", ph: "数据库密码", secret: true, required: true },
      { k: "database", label: "数据库名", ph: "默认连接的数据库", required: true },
      { k: "extra", type: "kvlist", label: "额外连接参数", hint: "键=值，可添加多条；如 ssl=true / application_name=my-app / statement_timeout=5000" },
    ],
  },
  {
    value: "k8s",
    label: "Kubernetes 集群",
    icon: "M12 2l8.5 5v10L12 22l-8.5-5V7L12 2zm4 6.5l-4-2.3-4 2.3v4.6l4 2.3 4-2.3V8.5z",
    hint: "kubeconfig 凭证（JOB 节点用 k8s Job 承载 runner 执行）。填一份完整 kubeconfig YAML（token / 客户端证书 / basic 鉴权皆可，SM4 加密落库），集群 API server 需对控制面网络可达；命名空间未在节点上指定时默认用这里填的。",
    guide: [
      { title: "获取 kubeconfig", text: "ACK：集群 → 基本信息 → 连接信息 → 复制公网/内网 kubeconfig；自建集群导出 kubeconfig 文件内容", url: "https://cs.console.aliyun.com" },
      { title: "网络可达", text: "确认集群 API server 地址（cluster.server）能被控制面（FC）访问：公网端点或与 FC 同 VPC；内网地址在表单里会被打码展示", url: "https://cs.console.aliyun.com" },
    ],
    fields: [
      { k: "kubeconfig", type: "textarea", label: "kubeconfig（YAML）", ph: "粘贴完整 kubeconfig 内容，如：\napiVersion: v1\nkind: Config\ncurrent-context: dev\nclusters:…", required: true, secret: true },
      { k: "namespace", label: "默认命名空间（可选）", ph: "如 default / build，JOB 节点未指定时使用" },
    ],
  },
  {
    value: "ssh",
    label: "SSH 密钥",
    icon: "M3 16h18M5 16v4h14v-4m-9-8h4m-6 4h8a4 4 0 0 0 4-4V4",
    hint: "注入容器 ~/.ssh：git clone 私有仓库 / scp / rsync 使用。私钥仅保存一次，不可回显；known_hosts 留空时首次连接自动接受主机指纹。",
    fields: [
      { k: "privateKey", type: "textarea", label: "私钥", ph: "-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----", required: true, secret: true },
      { k: "passphrase", label: "私钥口令（可选）", ph: "无口令私钥可留空", secret: true },
      { k: "knownHosts", type: "textarea", label: "known_hosts（可选）", ph: "粘贴主机指纹行；留空则首次连接自动接受", secret: true },
    ],
  },
  {
    value: "maven",
    label: "Maven 私服",
    icon: "M4 5h16v14H4zM8 9h3M8 13h8M12 9l-1.5 4",
    hint: "写入容器 ~/.m2/settings.xml：mvn 构建拉取/发布私有 Nexus/Artifactory 包时自动携带该 server 凭证（无需 -s 指定）。",
    fields: [
      { k: "serverId", label: "Server ID", ph: "如 nexus-central（对应私有仓库的 server id）", required: true },
      { k: "username", label: "用户名", ph: "私服账号", required: true },
      { k: "password", label: "密码 / Token", ph: "私服密码或令牌", secret: true, required: true },
      { k: "registryUrl", label: "仓库地址（可选，作镜像）", ph: "https://nexus.example.com/repository/maven-public/" },
    ],
  },
  {
    value: "npm",
    label: "npm 私有源",
    icon: "M6 4h12M6 20l6-16M12 4v16",
    hint: "写入容器 ~/.npmrc 的 authToken：npm i 拉取私有包 / npm publish 发布到私有源时自动携带凭证。",
    fields: [
      { k: "registry", label: "Registry 地址", ph: "https://registry.npmjs.org/", required: true },
      { k: "token", label: "Access Token", ph: "私有源访问令牌", secret: true, required: true },
    ],
  },
];

// runner 型节点（Shell / Job 执行）可注入容器的凭证类型
export const RUNNER_CRED_KINDS = ["ssh", "maven", "docker-registry", "npm", "s3"];
export const credKind = (v) => CRED_KINDS.find((k) => k.value === v);
export const credKindLabel = (v) => credKind(v)?.label ?? v;