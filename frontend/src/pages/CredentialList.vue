<!-- 凭证列表：每行一条 + 操作栏在右 + 批量删除 + 关联流水线跳转 -->
<script setup>
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { notify } from "../lib/notify.js";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { fetchCredentials, deleteCredential } from "../api/credential.js";
import { fetchPipelines } from "../api/pipeline.js";
import { credKind, credKindLabel } from "../lib/kinds.js";

const router = useRouter();
const list = ref([]);
const pipelines = ref([]);
const loading = ref(false);
const selected = ref(new Set());

const confirm = ref({ open: false, message: "", detail: "", ids: [] });
const deleting = ref(false);

const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }) : "—";

// 计算每条凭证被哪些流水线的审批节点引用（params.robot === 凭证名）
const usedCount = (c) =>
  (pipelines.value || []).filter((p) => (p.spec_json?.nodes ?? []).some((n) => n.type === "approval" && n.params?.robot === c.name)).length;

const refresh = async () => {
  loading.value = true;
  try {
    const [creds, pipes] = await Promise.all([fetchCredentials().catch(() => []), fetchPipelines().catch(() => [])]);
    list.value = creds;
    pipelines.value = pipes;
  } finally { loading.value = false; }
};
onMounted(refresh);

const allChecked = computed(() => list.value.length > 0 && list.value.every((c) => selected.value.has(c.id)));
const toggleAll = () => { selected.value = allChecked.value ? new Set() : new Set(list.value.map((c) => c.id)); };
const toggle = (id) => {
  const s = new Set(selected.value);
  s.has(id) ? s.delete(id) : s.add(id);
  selected.value = s;
};

const goNew = () => router.push("/credentials/new");
const goEdit = (c) => router.push(`/credentials/${c.id}`);

const askDelete = (c) => {
  confirm.value = { open: true, ids: [c.id], message: `确定删除凭证「${c.name}」吗？`, detail: "引用该凭证的审批节点将无法再正常发送审批卡片。" };
};
const askBatchDelete = () => {
  confirm.value = { open: true, ids: [...selected.value], message: `确定删除选中的 ${selected.value.size} 条凭证吗？`, detail: "引用它们的审批节点将无法再正常发送审批卡片。" };
};
const doDelete = async () => {
  const ids = confirm.value.ids;
  deleting.value = true;
  try {
    for (const id of ids) await deleteCredential(id);
    ids.forEach((id) => selected.value.delete(id));
    notify({ type: "success", message: `已删除 ${ids.length} 条凭证` });
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
        <h1 class="lp-title display">凭证</h1>
        <p class="lp-sub muted">集中管理机器人、仓库与对象存储的访问密钥，落库前以 SM4 加密。</p>
      </div>
      <div class="lp-actions">
        <span class="lp-count mono">{{ list.length }} 条</span>
        <button class="btn" @click="refresh" :disabled="loading">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>
          刷新
        </button>
        <button class="btn btn-accent" @click="goNew">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          新建凭证
        </button>
      </div>
    </header>

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
      <div v-if="!list.length && !loading" class="empty">
        <svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a5 5 0 0 1 5 5 3 3 0 0 1 3 3v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-3a3 3 0 0 1 2-2.8M8.5 11.5V9a3.5 3.5 0 0 1 7 0"/></svg>
        <p class="dim">暂无凭证，点击右上角「新建凭证」开始。</p>
      </div>

      <div v-else class="twrap">
        <table class="dtable">
          <thead>
            <tr>
              <th class="col-check"><input class="row-check" type="checkbox" :checked="allChecked" @change="toggleAll" aria-label="全选" /></th>
              <th class="mono">名称</th>
              <th class="mono">类型</th>
              <th class="mono">引用流水线</th>
              <th class="mono">创建时间</th>
              <th class="mono col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in list" :key="c.id" :class="{ sel: selected.has(c.id) }">
              <td class="col-check"><input class="row-check" type="checkbox" :checked="selected.has(c.id)" @change="toggle(c.id)" @click.stop :aria-label="`选择 ${c.name}`" /></td>
              <td>
                <div class="cell-main">
                  <span class="link-strong" @click="goEdit(c)">{{ c.name }}</span>
                  <span class="cell-sub">#{{ String(c.id).padStart(4, "0") }}</span>
                </div>
              </td>
              <td><span class="badge badge-neutral" :style="{ color: 'var(--accent)', background: 'var(--accent-soft)' }">{{ credKindLabel(c.kind) }}</span></td>
              <td>
                <a v-if="usedCount(c) > 0" class="link" @click="router.push(`/pipelines?credential=${encodeURIComponent(c.name)}`)">{{ usedCount(c) }} 条 →</a>
                <span v-else class="cell-mono dim">—</span>
              </td>
              <td class="cell-time">{{ fmtDate(c.created_at) }}</td>
              <td class="col-actions">
                <div class="cell-actions">
                  <button class="act-btn" @click="goEdit(c)">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
                    编辑
                  </button>
                  <button class="act-btn danger" @click="askDelete(c)">
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
      title="删除凭证"
      :message="confirm.message"
      :detail="confirm.detail"
      :loading="deleting"
      @close="confirm.open = false"
      @confirm="doDelete"
    />
  </div>
</template>

<style scoped>
.cd-enter-active, .cd-leave-active { transition: all 0.2s var(--ease); }
.cd-enter-from, .cd-leave-to { opacity: 0; transform: translateY(6px); }
</style>