<!-- 凭证页 k8s 类型：「📖 权限与 kubeconfig 说明」弹窗 -->
<!-- 内容以 data 常量维护：所需 RBAC 最小清单 / ClusterRole 示例 / 创建步骤 / kubectl 自检 / 可达性注意 -->
<script setup>
import { ref } from "vue";

const open = ref(false);

// 最小 RBAC：仅覆盖「建 Job + 附属 Secret + 观察结果」所需读写的资源
const RULES = [
  { group: "batch", resource: "jobs", verbs: "create · get · list · watch · delete" },
  { group: "", resource: "secrets", verbs: "create · get · delete（随 Job 的凭证 Secret 生命周期）" },
  { group: "", resource: "pods", verbs: "get · list · watch（观察执行进度，可选）" },
  { group: "", resource: "namespaces", verbs: "get（连通性探测用）" },
];

const CLUSTER_ROLE = `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: cloudshuttle-exec
rules:
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "get", "list", "watch", "delete"]
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["create", "get", "delete"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["get"]`;

const STEPS = [
  {
    title: "创建 ServiceAccount",
    code: `kubectl create serviceaccount cloudshuttle-exec -n default`,
  },
  {
    title: "绑定权限（集群级，或改用 Namespace 级 Role 限定到单命名空间）",
    code: `kubectl create clusterrolebinding cloudshuttle-exec \\
  --clusterrole=cloudshuttle-exec \\
  --serviceaccount=default:cloudshuttle-exec`,
  },
  {
    title: "生成 kubeconfig —— 方式 A：Token 鉴权",
    code: `TOKEN=$(kubectl create token cloudshuttle-exec -n default)
kubectl config set-credentials cloudshuttle-exec --token="$TOKEN"
kubectl config set-context cloudshuttle-exec-context \\
  --cluster=<集群名> --user=cloudshuttle-exec
kubectl config use-context cloudshuttle-exec-context`,
  },
  {
    title: "生成 kubeconfig —— 方式 B：客户端证书鉴权",
    code: `kubectl get secret -o jsonpath='{.items[?(@.metadata.name|startswith("cloudshuttle-exec-token-"))]}' \\
  | 用 csr 签发客户端证书后导入即可（令牌额度有限，长任务推荐证书），
再按方式 A 的步骤 set-credentials / set-context 导出 kubeconfig 文件内容粘贴到上方。`,
  },
  {
    title: "自检：确认权限可满足平台需要的全部操作",
    code: `kubectl auth can-i create jobs -A
kubectl auth can-i create secrets -A
kubectl auth can-i get pods -A
kubectl auth can-i get namespaces -A`,
  },
];

const copy = async (text) => {
  try { await navigator.clipboard.writeText(text); }
  catch { /* 剪贴板不可用时静默 */ }
};
</script>

<template>
  <div class="k8s-guide">
    <button type="button" class="btn btn-ghost btn-sm" @click="open = true">📖 权限与 kubeconfig 说明</button>

    <div v-if="open" class="kg-mask" @click.self="open = false">
      <div class="kg-panel">
        <header class="kg-head">
          <div>
            <h3 class="kg-title">Kubernetes 凭证所需权限与 kubeconfig 创建</h3>
            <p class="kg-sub muted">集群侧准备就绪后，把完整 kubeconfig 粘贴到上方表单即可保存。</p>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" @click="open = false">✕ 关闭</button>
        </header>

        <section class="kg-sec">
          <h4 class="kg-sec-title">1. 所需 RBAC 最小权限</h4>
          <table class="kg-table">
            <thead><tr><th>资源</th><th>操作</th><th>说明</th></tr></thead>
            <tbody>
              <tr v-for="r in RULES" :key="r.resource">
                <td class="mono">{{ r.group ? r.group + "/" + r.resource : r.resource }}</td>
                <td class="mono kg-verbs">{{ r.verbs }}</td>
                <td>{{ (r.resource === "jobs"
                  ? "创建执行的 Job；内存/超时清理由 TTL 触发删除"
                  : r.resource === "secrets"
                  ? "存放附加凭证（SSH / Maven / Docker / npm / S3）；随 Job 删除"
                  : r.resource === "pods"
                  ? "观察执行进度（日志/状态）；无此权限不影响执行"
                  : "连通性探测需要") }}</td>
              </tr>
            </tbody>
          </table>
          <p class="kg-note">权限越权提示：泄露集群读风险较低，但请不要授予 <code class="mono">delete pods</code> / <code class="mono">escalate</code> / <code class="mono">impersonate</code> 等敏感操作。</p>
        </section>

        <section class="kg-sec">
          <h4 class="kg-sec-title">2. ClusterRole 示例（可直接复制）</h4>
          <div class="kg-code">
            <button type="button" class="kg-copy" @click="copy(CLUSTER_ROLE)">复制</button>
            <pre class="mono kg-pre">{{ CLUSTER_ROLE }}</pre>
          </div>
          <p class="kg-note">仅需单命名空间时，可把 ClusterRole 换成同名 Namespace 级 Role（去掉 <code class="mono">--clusterrole</code> 用 <code class="mono">--role</code>），并把上面 rules 资源改为对应命名空间。</p>
        </section>

        <section class="kg-sec">
          <h4 class="kg-sec-title">3. 创建步骤（建 SA → 绑定 → 导出 kubeconfig → 自检）</h4>
          <ol class="kg-steps">
            <li v-for="(s, i) in STEPS" :key="i" class="kg-step">
              <div class="kg-step-title">{{ i + 1 }}. {{ s.title }}</div>
              <pre class="mono kg-pre kg-pre-sm">{{ s.code }}</pre>
            </li>
          </ol>
        </section>

        <section class="kg-sec">
          <h4 class="kg-sec-title">4. 网络可达性</h4>
          <ul class="kg-notes">
            <li>确认 <code class="mono">cluster.server</code>（集群 API server 地址）能被平台控制面访问：优先使用 ACK 的公网端点，或把控制面与集群接入同一 VPC。</li>
            <li><code class="mono">insecure-skip-tls-verify: true</code> 仅建议在自签名证书且无法导入 CA 时使用。</li>
            <li>集群侧若启用了 OIDC / RAM 鉴权，请确认所用 token 仍具备上述 RBAC 权限。</li>
          </ul>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.k8s-guide { margin-top: 10px; }
.kg-mask {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(4, 18, 26, .55); backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.kg-panel {
  width: min(860px, 96vw); max-height: 86vh; overflow: auto;
  background: var(--bg-1, #0e1a23); border: 1px solid var(--line, #1f2f3b);
  border-radius: 14px; padding: 18px 20px;
}
.kg-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.kg-title { font-size: 15px; margin: 0; }
.kg-sub { font-size: 12px; margin: 4px 0 0; }
.kg-sec { margin-top: 16px; }
.kg-sec-title { font-size: 13px; margin: 0 0 8px; }
.kg-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.kg-table th, .kg-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line, #1f2f3b); vertical-align: top; }
.kg-table th { color: var(--text-2, #93a5b3); font-weight: 600; }
.kg-verbs { color: var(--accent, #2fb6a3); }
.kg-note { font-size: 12px; color: var(--text-2, #93a5b3); margin: 8px 0 0; line-height: 1.6; }
.kg-code { position: relative; }
.kg-copy {
  position: absolute; right: 8px; top: 8px; z-index: 1;
  font-size: 11px; padding: 3px 8px; border-radius: 6px;
  background: var(--bg-0, #0a141c); color: var(--accent, #2fb6a3);
  border: 1px solid var(--line, #1f2f3b); cursor: pointer;
}
.kg-pre {
  background: var(--bg-0, #0a141c); border: 1px solid var(--line, #1f2f3b);
  border-radius: 10px; padding: 12px; overflow: auto;
  font-size: 12px; line-height: 1.55; white-space: pre; margin: 0;
}
.kg-pre-sm { padding: 10px 12px; font-size: 11.5px; }
.kg-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.kg-step-title { font-size: 12.5px; font-weight: 600; margin-bottom: 6px; }
.kg-notes { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.7; color: var(--text-2, #93a5b3); }
</style>