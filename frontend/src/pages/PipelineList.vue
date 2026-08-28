<!-- 流水线列表：每行一条 + 操作栏在行最右 + 批量删除 -->
<script setup>
import { ref, computed, onMounted } from "vue";
import { useRouter, useRoute } from "vue-router";
import { notify } from "../lib/notify.js";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { fetchPipelines, deletePipeline, runPipeline } from "../api/pipeline.js";

const router = useRouter();
const route = useRoute();
const list = ref([]);
const loading = ref(false);
const selected = ref(new Set());

const confirm = ref({ open: false, message: "", detail: "", mode: "single", ids: [] });
const deleting = ref(false);

const nodeCount = (p) => p.spec_json?.nodes?.length ?? 0;
const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

// 关联筛选：/?credential=凭证名 或 /?image=镜像名（由凭证/镜像页跳转而来）
const filter = computed(() => {
  const c = route.query.credential;
  const im = route.query.image;
  if (c) return { kind: "credential", value: c, label: `凭证：${c}`, used: (p) => (p.spec_json?.nodes ?? []).some((n) => n.type === "approval" && n.params?.robot === c) };
  if (im) return { kind: "image", value: im, label: `镜像：${im}`, used: (p) => (p.spec_json?.nodes ?? []).some((n) => n.type === "shell" && n.params?.image === im) };
  return null;
});
const filtered = computed(() => (filter.value ? list.value.filter(filter.value.used) : list.value));
const clearFilter = () => router.replace("/pipelines");

const refresh = async () => {
  loading.value = true;
  try { list.value = await fetchPipelines().catch(() => []); }
  finally { loading.value = false; }
};
onMounted(refresh);

const allChecked = computed(() => list.value.length > 0 && list.value.every((p) => selected.value.has(p.id)));
const toggleAll = () => {
  selected.value = allChecked.value ? new Set() : new Set(list.value.map((p) => p.id));
};
const toggle = (id) => {
  const s = new Set(selected.value);
  s.has(id) ? s.delete(id) : s.add(id);
  selected.value = s;
};

const goNew = () => router.push("/pipelines/new");
const goEdit = (p) => router.push(`/pipelines/${p.id}`);
const edit = (p) => goEdit(p);

const run = async (p) => {
  try { await runPipeline(p.id); notify({ type: "success", message: `已触发运行「${p.name}」，可去执行页查看` }); }
  catch { /* 全局拦截器提示 */ }
};

const askDelete = (p) => {
  confirm.value = {
    open: true, mode: "single", ids: [p.id],
    message: `确定删除流水线「${p.name}」吗？`,
    detail: "其全部执行历史将一并删除，此操作不可恢复。",
  };
};
const askBatchDelete = () => {
  confirm.value = {
    open: true, mode: "batch", ids: [...selected.value],
    message: `确定删除选中的 ${selected.value.size} 条流水线吗？`,
    detail: "关联的执行历史将一并删除，此操作不可恢复。",
  };
};

const doDelete = async () => {
  const ids = confirm.value.ids;
  deleting.value = true;
  try {
    for (const id of ids) await deletePipeline(id);
    ids.forEach((id) => selected.value.delete(id));
    notify({ type: "success", message: `已删除 ${ids.length} 条流水线` });
    confirm.value.open = false;
    await refresh();
  } catch { /* 全局拦截器提示 */ }
  finally { deleting.value = false; }
};
</script>

<template>
  <div class="listpage">
    <header class="lp-head rise">
      <div>
        <h1 class="lp-title display">流水线</h1>
        <p class="lp-sub muted">编排 shell 执行与人工审批节点，构建可重跑的 Serverless 工作流。</p>
      </div>
      <div class="lp-actions">
        <span class="lp-count mono">{{ list.length }} 条</span>
        <button class="btn" @click="refresh" :disabled="loading">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>
          刷新
        </button>
        <button class="btn btn-accent" @click="goNew">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          新建流水线
        </button>
      </div>
    </header>

    <div v-if="filter" class="filter-chip rise">
      <span class="mono-tag">关联筛选</span>
      <b>{{ filter.label }}</b>
      <span class="dim">{{ filtered.length }} 条</span>
      <button class="btn btn-sm btn-ghost" @click="clearFilter">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        清除筛选
      </button>
    </div>

    <Transition name="cd" appear>
      <div v-if="selected.size" class="batchbar">
        <span class="batchbar-count">已选择 <b>{{ selected.size }}</b> 条</span>
        <div class="batchbar-acts">
          <button class="btn btn-ghost" @click="selected = new Set()">取消选择</button>
          <button class="btn btn-danger-solid" @click="askBatchDelete">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
            批量删除
          </button>
        </div>
      </div>
    </Transition>

    <section class="card data-card rise" style="animation-delay:.06s">
      <div v-if="!filtered.length && !loading" class="empty">
        <svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h11M14 6a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0zM3 12h11M14 12a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0zM3 18h11M14 18a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0z"/></svg>
        <p class="dim">{{ filter ? "没有匹配的流水线。" : "暂无流水线，点击右上角「新建流水线」开始。" }}</p>
      </div>

      <div v-else class="twrap">
        <table class="dtable">
          <thead>
            <tr>
              <th class="col-check"><input class="row-check" type="checkbox" :checked="allChecked" @change="toggleAll" aria-label="全选" /></th>
              <th class="mono">名称</th>
              <th class="mono">描述</th>
              <th class="mono">节点</th>
              <th class="mono">修订</th>
              <th class="mono">更新时间</th>
              <th class="mono col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in filtered" :key="p.id" :class="{ sel: selected.has(p.id) }">
              <td class="col-check"><input class="row-check" type="checkbox" :checked="selected.has(p.id)" @change="toggle(p.id)" @click.stop :aria-label="`选择 ${p.name}`" /></td>
              <td>
                <div class="cell-main">
                  <span class="link-strong" @click="goEdit(p)">{{ p.name || ("流水线 #" + p.id) }}</span>
                  <span class="cell-sub">#{{ String(p.id).padStart(4, "0") }}</span>
                </div>
              </td>
              <td class="cell-mono">{{ p.description || "—" }}</td>
              <td><span class="badge badge-info">{{ nodeCount(p) }}</span></td>
              <td class="cell-mono">v{{ p.rev }}</td>
              <td class="cell-time">{{ fmtDate(p.updated_at) }}</td>
              <td class="col-actions">
                <div class="cell-actions">
                  <button class="act-btn accent" title="立即运行" @click="run(p)">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    运行
                  </button>
                  <button class="act-btn" @click="edit(p)">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
                    编辑
                  </button>
                  <button class="act-btn danger" @click="askDelete(p)">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
                    删除
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
      title="删除流水线"
      :message="confirm.message"
      :detail="confirm.detail"
      :loading="deleting"
      loading-text="删除中…"
      @close="confirm.open = false"
      @confirm="doDelete"
    />
  </div>
</template>

<style scoped>
.filter-chip {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 14px;
  background: var(--accent-soft);
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  animation: riseIn 0.3s var(--ease) both;
}
.filter-chip b { font-family: var(--font-display); font-size: 13px; color: var(--text-1); }
.cd-enter-active, .cd-leave-active { transition: all 0.2s var(--ease); }
.cd-enter-from, .cd-leave-to { opacity: 0; transform: translateY(6px); }
</style>