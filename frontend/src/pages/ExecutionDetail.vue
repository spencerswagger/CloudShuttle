<!-- 执行详情页 -->
<script setup>
import { ref, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { getExecution, cancelExecution, rerunExecution } from "../api/execution.js";
import { notify } from "../lib/notify.js";

const route = useRoute();
const router = useRouter();

const exec = ref(null);
const loading = ref(true);
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

const meta = computed(() => STATUS[exec.value?.status] || { label: exec.value?.status ?? "—", cls: "badge-neutral", dot: "var(--text-3)" });
const cancellable = computed(() => ["queued", "running"].includes(exec.value?.status));

const fmt = (iso) => iso ? new Date(iso).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";

const steps = computed(() => {
  const s = exec.value?.steps;
  if (Array.isArray(s)) return s;
  if (Array.isArray(exec.value?.spec_json?.steps)) return exec.value.spec_json.steps;
  return [];
});

const refresh = async () => {
  loading.value = true;
  try { exec.value = await getExecution(+route.params.id); }
  catch { /* 全局拦截器提示，停留在空态 */ }
  finally { loading.value = false; }
};
onMounted(refresh);

const cancel = async () => {
  acting.value = true;
  try { await cancelExecution(+route.params.id); notify({ type: "success", message: "已终止执行" }); await refresh(); }
  catch { /* 全局拦截器提示 */ }
  finally { acting.value = false; }
};
const rerun = async () => {
  acting.value = true;
  try { await rerunExecution(+route.params.id); notify({ type: "success", message: "已重新触发" }); await refresh(); }
  catch { /* 全局拦截器提示 */ }
  finally { acting.value = false; }
};

const triggerLabel = computed(() => {
  const t = exec.value?.trigger;
  if (!t) return "API";
  return t.source || t.trigger || t.via || "API";
});
</script>

<template>
  <div class="form-page">
    <header class="lp-head rise">
      <div class="title-wrap">
        <button class="btn btn-ghost" @click="router.push('/executions')">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          返回列表
        </button>
        <div>
          <h1 class="lp-title display">执行详情 · #{{ String(exec?.id ?? "").padStart(4, "0") }}</h1>
          <p class="lp-sub muted">流水线的单次运行快照。</p>
        </div>
      </div>
      <div class="lp-actions">
        <button v-if="cancellable" class="btn btn-danger" :disabled="acting" @click="cancel">终止执行</button>
        <button class="btn btn-accent" :disabled="acting" @click="rerun">重新触发</button>
      </div>
    </header>

    <section v-if="loading" class="card empty rise"><p class="dim">加载中…</p></section>

    <template v-else-if="exec">
      <section class="card meta-card rise" style="animation-delay:.04s">
        <div class="meta-item">
          <span class="field-label">状态</span>
          <span class="badge" :class="meta.cls" :style="{ '--dot': meta.dot }">{{ meta.label }}</span>
        </div>
        <div class="meta-item">
          <span class="field-label">流水线</span>
          <a class="link-strong" @click="router.push(`/pipelines/${exec.pipeline_id}`)">{{ exec.pipeline_name ?? ("流水线 #" + exec.pipeline_id) }} →</a>
        </div>
        <div class="meta-item">
          <span class="field-label">Run</span>
          <span class="cell-mono">R{{ exec.run_no }}</span>
        </div>
        <div class="meta-item">
          <span class="field-label">触发来源</span>
          <span class="cell-mono">{{ triggerLabel }}</span>
        </div>
        <div class="meta-item">
          <span class="field-label">创建时间</span>
          <span class="cell-time">{{ fmt(exec.created_at) }}</span>
        </div>
        <div class="meta-item">
          <span class="field-label">开始时间</span>
          <span class="cell-time">{{ fmt(exec.started_at) }}</span>
        </div>
        <div class="meta-item">
          <span class="field-label">结束时间</span>
          <span class="cell-time">{{ fmt(exec.finished_at) }}</span>
        </div>
      </section>

      <section v-if="steps.length" class="card steps-card rise" style="animation-delay:.08s">
        <h3 class="block-title display">执行步骤</h3>
        <ol class="steps">
          <li v-for="(s, i) in steps" :key="i" class="step">
            <span class="step-idx mono">{{ String(i + 1).padStart(2, "0") }}</span>
            <span class="step-name">{{ s.node?.name || s.name || `STEP ${i + 1}` }}</span>
            <span class="step-status mono">{{ s.status || "—" }}</span>
          </li>
        </ol>
      </section>

      <section v-if="exec.log" class="card log-card rise" style="animation-delay:.1s">
        <h3 class="block-title display">运行日志</h3>
        <pre class="log-pre mono">{{ exec.log }}</pre>
      </section>

      <section v-if="!steps.length && !exec.log" class="card empty rise">
        <p class="dim">该执行暂无步骤与日志输出。</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.title-wrap { display: flex; align-items: flex-end; gap: 14px; }

.meta-card {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 18px 22px; padding: 20px 22px;
}
.meta-item { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.meta-item .field-label { margin-bottom: 0; }

.block-title { margin: 0 0 12px; font-size: 14px; font-weight: 700; letter-spacing: 0.03em; }
.steps-card, .log-card { padding: 20px 22px; }
.steps { list-style: none; margin: 0; padding: 0; }
.step {
  display: flex; align-items: center; gap: 14px;
  padding: 10px 2px; border-bottom: 1px solid var(--line);
  font-size: 13px;
}
.step:last-child { border-bottom: none; }
.step-idx { font-size: 11px; color: var(--accent); }
.step-name { flex: 1; color: var(--text-1); }
.step-status { font-size: 11px; color: var(--text-3); }

.log-pre {
  margin: 0; padding: 14px 16px;
  background: var(--bg-0); border: 1px solid var(--line);
  border-radius: 10px; font-size: 12px; line-height: 1.6;
  color: var(--text-2); overflow-x: auto; white-space: pre-wrap; word-break: break-word;
}
</style>