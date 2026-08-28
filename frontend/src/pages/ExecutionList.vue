<!-- 执行列表：每行一条 + 操作栏在右 + 流水线/详情跳转 -->
<script setup>
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { fetchExecutions, cancelExecution, rerunExecution } from "../api/execution.js";
import ConfirmDialog from "../components/ConfirmDialog.vue";

const router = useRouter();
const list = ref([]);
const loading = ref(false);
const confirm = ref({ open: false, message: "", id: null });
const acting = ref(false);

const STATUS = {
  queued:    { label: "排队中", cls: "badge-neutral", dot: "var(--text-3)" },
  running:   { label: "运行中", cls: "badge-info",     dot: "var(--info)" },
  succeeded: { label: "成功",   cls: "badge-ok",       dot: "var(--ok)" },
  done:      { label: "完成",   cls: "badge-ok",       dot: "var(--ok)" },
  failed:    { label: "失败",   cls: "badge-err",      dot: "var(--err)" },
  rejected:  { label: "已拒绝", cls: "badge-err",      dot: "var(--err)" },
  cancelled: { label: "已取消", cls: "badge-neutral",  dot: "var(--text-3)" },
  approve:   { label: "审批中", cls: "badge-warn",     dot: "var(--warn)" },
  eci:       { label: "运行中", cls: "badge-info",     dot: "var(--info)" },
};
const meta = (s) => STATUS[s] || { label: s, cls: "badge-neutral", dot: "var(--text-3)" };

const CANCELLABLE = ["queued", "running"];
const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

const refresh = async () => {
  loading.value = true;
  try { list.value = await fetchExecutions().catch(() => []); }
  finally { loading.value = false; }
};
onMounted(refresh);

const goDetail = (e) => router.push(`/executions/${e.id}`);
const goPipeline = (pipelineId) => router.push(`/pipelines/${pipelineId}`);

const rerun = async (e) => {
  try { await rerunExecution(e.id); } catch { /* 全局拦截器提示 */ }
  await refresh();
};
const askCancel = (e) => {
  confirm.value = { open: true, id: e.id, message: `确认终止执行 #${String(e.id).padStart(4, "0")} 吗？`, detail: "该操作不可撤销。" };
};
const doCancel = async () => {
  acting.value = true;
  try { await cancelExecution(confirm.value.id); confirm.value.open = false; await refresh(); }
  catch { /* 全局拦截器提示 */ }
  finally { acting.value = false; }
};
</script>

<template>
  <div class="listpage">
    <header class="lp-head rise">
      <div>
        <h1 class="lp-title display">执行</h1>
        <p class="lp-sub muted">跟踪每个流水线实例的运行状态，可查看详情、重跑或终止。</p>
      </div>
      <div class="lp-actions">
        <span class="lp-count mono">{{ list.length }} 条</span>
        <button class="btn" @click="refresh" :disabled="loading">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>
          刷新
        </button>
      </div>
    </header>

    <section class="card data-card rise" style="animation-delay:.06s">
      <div v-if="!list.length && !loading" class="empty">
        <svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v4l2.5 2.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/></svg>
        <p class="dim">尚无执行记录，去流水线列表运行一条流水线吧。</p>
      </div>

      <div v-else class="twrap">
        <table class="dtable">
          <thead>
            <tr>
              <th class="mono">执行 ID</th>
              <th class="mono">流水线</th>
              <th class="mono">Run</th>
              <th class="mono">状态</th>
              <th class="mono">触发时间</th>
              <th class="mono col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in list" :key="e.id">
              <td>
                <div class="cell-main">
                  <span class="link-strong" @click="goDetail(e)">#{{ String(e.id).padStart(4, "0") }}</span>
                  <span class="cell-sub">{{ (e.trigger?.trigger || e.trigger?.source || e.trigger?.via || "api") }}</span>
                </div>
              </td>
              <td>
                <a class="link" @click="goPipeline(e.pipeline_id)">{{ e.pipeline_name ?? ("流水线 #" + e.pipeline_id) }}</a>
              </td>
              <td class="cell-mono">{{ "R" + String(e.run_no ?? 1) }}</td>
              <td><span class="badge" :class="meta(e.status).cls" :style="{ '--dot': meta(e.status).dot }">{{ meta(e.status).label }}</span></td>
              <td class="cell-time">{{ fmtDate(e.started_at) }}</td>
              <td class="col-actions">
                <div class="cell-actions">
                  <button class="act-btn" @click="goDetail(e)">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
                    详情
                  </button>
                  <button v-if="CANCELLABLE.includes(e.status)" class="act-btn danger" @click="askCancel(e)">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
                    终止
                  </button>
                  <button class="act-btn" @click="rerun(e)">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/></svg>
                    重跑
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <ConfirmDialog
      v-model:open="confirm.open"
      title="终止执行"
      :message="confirm.message"
      :detail="confirm.detail"
      confirm-text="确认终止"
      loading-text="终止中…"
      :loading="acting"
      @close="confirm.open = false"
      @confirm="doCancel"
    />
  </div>
</template>

<style scoped>
.cd-enter-active, .cd-leave-active { transition: all 0.2s var(--ease); }
.cd-enter-from, .cd-leave-to { opacity: 0; transform: translateY(6px); }
</style>