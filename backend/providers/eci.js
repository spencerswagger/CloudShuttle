// 阿里云 ECI（弹性容器实例）派发：CreateContainerGroup 一次性跑命令后回调。
// 为便于单测，pure 部分（解析/拼参）独立导出，SDK 调用通过注入的 create 函数完成。
import EciClient, { DescribeContainerGroupPriceRequest } from "@alicloud/eci20180808";

// 候选规格档位：主流 vCPU / 内存组合，覆盖常用档，供选中凭证后探测阿里云可购性
export const ECI_PROBE_COMBOS = [
  { cpu: 0.5, memory: 1 },
  { cpu: 1, memory: 1 },
  { cpu: 1, memory: 2 },
  { cpu: 2, memory: 2 },
  { cpu: 2, memory: 4 },
  { cpu: 2, memory: 8 },
  { cpu: 4, memory: 8 },
  { cpu: 4, memory: 16 },
  { cpu: 8, memory: 16 },
];

// 用 eci 凭证调 DescribeContainerGroupPrice 探测该 region 可购规格：
// 对候选组合并发询价，出口 <unavailable> 组合，返回可用 vCPU/内存档位及单价。
// 全部失败视为凭证/权限问题，抛可读错误；单个失败不影响其余。
// priceOf(cpu, memory) 由调用方注入，便于无 SDK 单测 probeSpecsOf。
export async function probeSpecsOf({ priceOf, combos = ECI_PROBE_COMBOS }) {
  const results = await Promise.all(combos.map(async (c) => {
    try {
      const body = await priceOf(c.cpu, c.memory);
      return { cpu: c.cpu, memory: c.memory, available: true, price: body };
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
  const mems = [...new Set(ok.map((r) => r.memory))];
  return { cpus, mems, combos: results };
}

// 生产路径：用 eci 凭证构建真实 Client 后委托 probeSpecsOf
export async function describeEciSpecs({ eci }) {
  const { accessKeyId, accessKeySecret, regionId } = eci ?? {};
  if (!accessKeyId || !accessKeySecret || !regionId) {
    throw new Error("ECI 凭证缺少 accessKeyId/accessKeySecret/regionId，请检查配置");
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

// 返回 ECI 常用预设档位（前端在接口探测失败/未选凭证时回退）
export const ECI_PRESET_CHOICES = {
  cpus: [0.5, 1, 2, 4, 8],
  mems: [1, 2, 4, 8, 16],
};

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