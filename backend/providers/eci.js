// 真实实现走阿里云 ECI OpenAPI（CreateContainerGroup 一次性跑命令后回调）。
// 为便于单测，工厂接收一个 create 函数注入。
export function createEciProvider({ create }) {
  return {
    // 派发一个镜像 + 命令的一次性容器；返回任务引用 jobRef 与回调地址
    async dispatch({ execId, nodeId, image, command, env, resource, timeout, callbackUrl, token }) {
      const jobRef = await create({
        image, command, env, resource, timeout,
        callbackUrl, token, name: `cloudshuttle-${execId}-${nodeId}`,
      });
      return { jobRef };
    },
  };
}