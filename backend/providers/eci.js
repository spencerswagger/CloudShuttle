// 阿里云 ECI（弹性容器实例）派发：CreateContainerGroup 一次性跑命令后回调。
// 为便于单测，pure 部分（解析/拼参）独立导出，SDK 调用通过注入的 create 函数完成。

// 从 shell 节点 resource 字符串解析 vCPU / 内存，支持「2 vCPU · 4 GiB」等人类可读写法
export function parseResource(resource) {
  const src = String(resource ?? "").toLowerCase();
  const cpu = src.match(/(\d+(?:\.\d+)?)\s*vcpu/)?.[1] ?? src.match(/(\d+(?:\.\d+)?)\s*cpu/)?.[1];
  const mem = src.match(/(\d+(?:\.\d+)?)\s*gib/)?.[1] ?? src.match(/(\d+(?:\.\d+)?)\s*gi/)?.[1];
  return {
    cpu: cpu ? Number(cpu) : undefined,
    memory: mem ? Number(mem) : undefined,
  };
}

// 把 CreateContainerGroup 请求参数拼成纯数据（不含 SDK 类实例），便于单测与 SDK 调用统一
export function buildCreateEciRequest({ name, image, command, env, resource, timeout, eci }) {
  if (!eci) {
    throw new Error("eci credential config missing; assign an ECI credential to the shell node");
  }
  const regionId = eci.regionId;
  if (!regionId) throw new Error("eci credential missing regionId");
  if (!eci.vswitchId) throw new Error("eci credential missing vswitchId");
  if (!eci.securityGroupId) throw new Error("eci credential missing securityGroupId");
  const { cpu, memory } = parseResource(resource);
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
    // 对象形式：可选项（未配置则不传，避免 SDL 校验误伤）
    cpu,
    memory,
    clientToken: name,
    activeDeadlineSeconds: Number(timeout) || undefined,
  };
}

// 注入式：dispatch 的 create 就是这里生成的函数，调用真实/仿真 Client 并返回 containerGroupId
export function createEciProvider({ create }) {
  return {
    // 派发一个镜像 + 命令的一次性容器；返回任务引用 jobRef（ECI 容器组 ID）
    async dispatch({ execId, nodeId, image, command, env, resource, timeout, callbackUrl, token, eci }) {
      const name = `cloudshuttle-${execId}-${String(nodeId).toLowerCase()}`;
      const jobRef = await create({
        name, image, command, env, resource, timeout, callbackUrl, token,
        eci: eci ?? null,
      });
      return { jobRef };
    },
  };
}