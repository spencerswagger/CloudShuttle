// 阿里云 ECI（弹性容器实例）派发：CreateContainerGroup 一次性跑命令后回调。
// 为便于单测，pure 部分（解析/拼参）独立导出，SDK 调用通过注入的 create 函数完成。
// CJS/ESM interop：`@alicloud/*` 的包用 __exportStar + exports.default 导出，
// ESM `import` 拿到的是 module.exports 整体对象，Client 类在 .default，
// 请求模型类（CreateContainerGroupRequest 等）也挂在同一个对象上。
import EciModule from "@alicloud/eci20180808";
import EcsModule from "@alicloud/ecs20140526";
import VpcModule from "@alicloud/vpc20160428";
const { default: EciClient, CreateContainerGroupRequest, DescribeContainerGroupPriceRequest } = EciModule;
const { default: EcsClient, DescribeSecurityGroupsRequest } = EcsModule;
const { default: VpcClient, DescribeVSwitchesRequest } = VpcModule;

// ECI 规格矩阵：阿里云按「vCPU → 支持的内存 GiB」定义规格组合（核内比 1:1 ~ 1:8），
// 不是任意 CPU × 任意内存。前端据此联动：先选 CPU，内存下拉只显示该 CPU 支持的档位并展示目录价。
export const ECI_SPEC_MATRIX = [
  { cpu: 0.5, memory: 1 }, { cpu: 0.5, memory: 2 },
  { cpu: 1, memory: 1 }, { cpu: 1, memory: 2 }, { cpu: 1, memory: 4 }, { cpu: 1, memory: 8 },
  { cpu: 2, memory: 2 }, { cpu: 2, memory: 4 }, { cpu: 2, memory: 8 }, { cpu: 2, memory: 16 },
  { cpu: 4, memory: 4 }, { cpu: 4, memory: 8 }, { cpu: 4, memory: 16 }, { cpu: 4, memory: 32 },
  { cpu: 8, memory: 8 }, { cpu: 8, memory: 16 }, { cpu: 8, memory: 32 }, { cpu: 8, memory: 64 },
];

// 从 DescribeContainerGroupPrice 响应 body 提取目录价（原价）与币种；拿不到时返回空
export function priceOfBody(body) {
  const price = body?.PriceInfo?.Price;
  if (!price) return null;
  return {
    originalPrice: typeof price.originalPrice === "number" ? price.originalPrice : null,
    tradePrice: typeof price.tradePrice === "number" ? price.tradePrice : null,
    currency: price.currency || "CNY",
  };
}

// 并发询价后整理为按 CPU 分组的可用档位（含价格）；全部失败抛可读错误，单个失败不影响其余。
// priceOf(cpu, memory) 由调用方注入，便于无 SDK 单测 probeSpecsOf。
export async function probeSpecsOf({ priceOf, combos = ECI_SPEC_MATRIX }) {
  const results = await Promise.all(combos.map(async (c) => {
    try {
      const body = await priceOf(c.cpu, c.memory);
      return { cpu: c.cpu, memory: c.memory, available: true, price: priceOfBody(body) };
    } catch (err) {
      return { cpu: c.cpu, memory: c.memory, available: false, reason: String(err?.message ?? err).slice(0, 200) };
    }
  }));
  const ok = results.filter((r) => r.available);
  if (!ok.length) {
    const reason = results[0]?.reason ?? "未知错误";
    throw new Error(`无法从阿里云校验 ECI 规格：${reason}（请确认凭证 AK/SK/Region 正确且已授权 AliyunECIFullAccess）`);
  }
  const cpus = [...new Set(ok.map((r) => r.cpu))];
  const byCpu = {};
  for (const r of ok) {
    (byCpu[r.cpu] ??= []).push({ memory: r.memory, price: r.price });
  }
  for (const [cpu, list] of Object.entries(byCpu)) {
    byCpu[cpu] = list.sort((a, b) => a.memory - b.memory);
  }
  return { cpus, byCpu, combos: results };
}

// 生产路径：用 eci 凭证（AK/SK/Region）构建真实 Client 后委托 probeSpecsOf
export async function describeEciSpecs({ eci }) {
  const { accessKeyId, accessKeySecret, regionId } = eci ?? {};
  if (!accessKeyId || !accessKeySecret || !regionId) {
    throw new Error("ECI 配置缺少 accessKeyId/accessKeySecret/regionId（凭证提供 AK/SK，地域在 Shell 节点配置）");
  }
  const client = new EciClient({
    accessKeyId,
    accessKeySecret,
    regionId,
    endpoint: `eci.${regionId}.aliyuncs.com`,
  });
  return probeSpecsOf({
    priceOf: async (cpu, memory) => {
      const request = new DescribeContainerGroupPriceRequest({ regionId, cpu, memory });
      const resp = await client.describeContainerGroupPrice(request);
      return resp?.body;
    },
  });
}

// 前端在接口探测失败/未选凭证时的预设规格（按 CPU 联动的内存档位；价格未知）
export const ECI_PRESET_CHOICES = {
  0.5: [1, 2],
  1: [1, 2, 4, 8],
  2: [2, 4, 8, 16],
  4: [4, 8, 16, 32],
  8: [8, 16, 32, 64],
};

// 汇总响应为轻量列表；listVswitches/listSecurityGroups 注入便于单测
export async function collectNetworks({ listVswitches, listSecurityGroups }) {
  const [vswResp, sgResp] = await Promise.all([listVswitches(), listSecurityGroups()]);
  const vswitches = (vswResp?.body?.VSwitches?.VSwitch ?? []).map((s) => ({
    id: s.VSwitchId, name: s.VSwitchName, zoneId: s.ZoneId,
  }));
  const securityGroups = (sgResp?.body?.SecurityGroups?.SecurityGroup ?? []).map((g) => ({
    id: g.SecurityGroupId, name: g.SecurityGroupName,
  }));
  return { vswitches, securityGroups };
}

// 把阿里云错误转成可读诊断（权限问题给出所需策略提示）
function networkErrorHint(err) {
  const msg = String(err?.message ?? err);
  const upper = msg.toUpperCase();
  const permissionHints = [
    [
      "交换机查询需要阿里云 VPC 只读（AliyunVPCReadOnlyAccess）或 ECI 相关权限",
      /FORBIDDEN|UNAUTHORIZED|NO_PERMISSION|ACCESSDENIED|NOT_AUTHORIZED/i,
    ],
    [
      "安全组查询需要阿里云 ECS 只读（AliyunECSReadOnlyAccess）权限",
      /FORBIDDEN|UNAUTHORIZED|NO_PERMISSION|ACCESSDENIED|NOT_AUTHORIZED/i,
    ],
  ];
  for (const [hint, re] of permissionHints) {
    if (re.test(upper)) return `${msg}；（${hint}，请在 RAM 中为该 AK 补充授权）`;
  }
  return msg;
}

// 生产路径：用 AK/SK/Region 查该地域的交换机（VPC 产品线）与安全组（ECS 产品线）。
// AK/SK 仅本次请求使用，不落库；调用失败时在错误信息里带出权限诊断。
export async function probeEciNetworks({ accessKeyId, accessKeySecret, regionId }) {
  if (!accessKeyId || !accessKeySecret || !regionId) {
    throw new Error("请先填写 AccessKey ID / AccessKey Secret / 地域 后再探测网络");
  }
  const ecsClient = new EcsClient({ accessKeyId, accessKeySecret, regionId });
  const vpcClient = new VpcClient({ accessKeyId, accessKeySecret, regionId });
  try {
    return await collectNetworks({
      listVswitches: async () => vpcClient.describeVSwitches(new DescribeVSwitchesRequest({ regionId })),
      listSecurityGroups: async () => ecsClient.describeSecurityGroups(new DescribeSecurityGroupsRequest({ regionId })),
    });
  } catch (err) {
    throw new Error(networkErrorHint(err));
  }
}

// 把 vCPU 数 / 内存 GiB 规范化：兼容字符串与数字输入
function normCpu(cpu) {
  const n = Number(cpu);
  return Number.isFinite(n) ? n : undefined;
}
function normMem(memory) {
  const n = Number(memory);
  return Number.isFinite(n) ? n : undefined;
}

// 把 CreateContainerGroup 请求参数拼成纯数据（不含 SDK 类实例），便于单测与 SDK 调用统一
export function buildCreateEciRequest({ name, image, command, env, cpu, memory, timeout, eci }) {
  if (!eci) {
    throw new Error("eci credential config missing; assign an ECI credential to the shell node");
  }
  const regionId = eci.regionId;
  if (!regionId) throw new Error("eci credential missing regionId");
  if (!eci.vswitchId) throw new Error("eci credential missing vswitchId");
  if (!eci.securityGroupId) throw new Error("eci credential missing securityGroupId");
  const envVars = (Array.isArray(env) ? env : [])
    .map((e) => ({ key: e?.k, value: String(e?.v ?? "") }))
    .filter((e) => e.key);
  return {
    regionId,
    containerGroupName: name,
    container: [{
      // 容器级 Name 必填：ECI 要求 Container 数组每个元素都有容器名，缺失报 ParameterRequired: Name is required
      name: "runner",
      image,
      command: Array.isArray(command) ? command : [command ?? "sh", "-c", command ?? 'echo "no command"'],
      environmentVar: envVars,
    }],
    vSwitchId: eci.vswitchId,
    securityGroupId: eci.securityGroupId,
    cpu: normCpu(cpu),
    memory: normMem(memory),
    clientToken: name,
    activeDeadlineSeconds: normCpu(timeout) || undefined,
  };
}

// 注入式：dispatch 的 create 就是这里生成的函数，调用真实/仿真 Client 并返回 containerGroupId
export function createEciProvider({ create }) {
  return {
    // 派发一个镜像 + 命令的一次性容器；返回任务引用 jobRef（ECI 容器组 ID）
    async dispatch({ execId, nodeId, image, command, env, cpu, memory, timeout, callbackUrl, token, eci }) {
      const name = `cloudshuttle-${execId}-${String(nodeId).toLowerCase()}`;
      const jobRef = await create({
        name, image, command, env, cpu, memory, timeout, callbackUrl, token,
        eci: eci ?? null,
      });
      return { jobRef };
    },
  };
}