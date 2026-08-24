<!-- frontend/src/pages/Executions.vue -->
<script setup>
import { ref, onMounted } from "vue";
import { fetchExecutions, triggerExecution } from "../api/execution.js";

const list = ref([]);
const loading = ref(false);

const STATUS = {
  queued:     { label: "排队中", cls: "badge-neutral", dot: "var(--text-3)" },
  running:    { label: "运行中", cls: "badge-info",     dot: "var(--info)" },
  succeeded:  { label: "成功",   cls: "badge-ok",       dot: "var(--ok)" },
  done:       { label: "完成",   cls: "badge-ok",       dot: "var(--ok)" },
  failed:     { label: "失败",   cls: "badge-err",      dot: "var(--err)" },
  rejected:   { label: "已拒绝", cls: "badge-err",      dot: "var(--err)" },
  approve:    { label: "审批中", cls: "badge-warn",     dot: "var(--warn)" },
  eci:        { label: "运行中", cls: "badge-info",     dot: "var(--info)" },
};
const meta = (s) => STATUS[s] || { label: s, cls: "badge-neutral", dot: "var(--text-3)" };

const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

const refresh = async () => {
  loading.value = true;
  try { list.value = await fetchExecutions().catch(() => []); } finally { loading.value = false; }
};
onMounted(refresh);

const trigger = async (id) => { await triggerExecution(id); await refresh(); };
</script>

<template>
  <div class="page">
    <header class="page-head rise">
      <div>
        <h1 class="head-title display">执行历史</h1>
        <p class="head-sub muted">跟踪每个管道实例的运行状态，可随时重新触发。</p>
      </div>
      <button class="btn btn-ghost" @click="refresh" :disabled="loading">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>
        刷新
      </button>
    </header>

    <section class="card table-card rise" style="animation-delay:.06s">
      <div v-if="!list.length && !loading" class="empty">
        <svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v4l2.5 2.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/></svg>
        <p class="dim">尚无执行记录，去画布运行一个管道吧。</p>
      </div>

      <div v-else class="t-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th class="mono">执行 ID</th>
              <th class="mono">管道</th>
              <th class="mono">Run</th>
              <th class="mono">状态</th>
              <th class="mono">触发时间</th>
              <th class="mono"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in list" :key="e.id" class="row">
              <td><span class="mono idle dim">#{{ String(e.id).padStart(4, "0") }}</span></td>
              <td><span class="pname display">{{ e.pipeline_name ?? "pipeline-" + e.pipeline_id }}</span></td>
              <td><span class="mono run">{{ e.run_no ?? "—" }}</span></td>
              <td><span class="badge" :class="meta(e.status).cls" :style="{ '--dot': meta(e.status).dot }">{{ meta(e.status).label }}</span></td>
              <td><span class="mono t time">{{ fmtDate(e.started_at) }}</span></td>
              <td class="right">
                <button class="btn btn-sm rerun" @click="trigger(e.pipeline_id)">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/></svg>
                  重跑
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 18px; max-width: 1000px; }
.page-head { display: flex; align-items: flex-end; justify-content: space-between; padding-bottom: 2px; }
.head-title { margin: 0; font-size: 26px; font-weight: 700; }
.head-sub { margin: 6px 0 0; font-size: 13.5px; }

.table-card { overflow: hidden; }
.t-wrap { overflow-x: auto; }
.tbl { width: 100%; border-collapse: collapse; }
.tbl thead th {
  text-align: left; font-size: 10.5px; font-weight: 600; letter-spacing: .08em;
  color: var(--text-3); text-transform: uppercase;
  padding: 13px 18px; border-bottom: 1px solid var(--line);
  background: var(--bg-2);
  white-space: nowrap;
}
.tbl tbody td { padding: 14px 18px; border-bottom: 1px solid var(--line); font-size: 13px; }
.tbl tbody tr:last-child td { border-bottom: none; }
.tbl tbody tr { transition: background .14s; }
.tbl tbody tr:hover { background: var(--bg-2); }
.idle { letter-spacing: .05em; }
.pname { font-weight: 600; font-size: 13.5px; color: var(--text-1); }
.run { color: var(--accent); font-size: 12px; }
.time { color: var(--text-2); font-size: 12px; }
.right { text-align: right; }
.rerun { color: var(--info); background: var(--info-soft); border-color: transparent; }
.rerun:hover { background: rgba(111,156,255,.2); }
</style>