<!-- 镜像列表：每行一条 + 操作栏在右 + 批量删除 + 关联流水线跳转 -->
<script setup>
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { notify } from "../lib/notify.js";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { fetchImages, deleteImage } from "../api/image.js";
import { fetchPipelines } from "../api/pipeline.js";

const router = useRouter();
const list = ref([]);
const pipelines = ref([]);
const loading = ref(false);
const selected = ref(new Set());

const confirm = ref({ open: false, message: "", detail: "", ids: [] });
const deleting = ref(false);

const usedCount = (im) =>
  (pipelines.value || []).filter((p) => (p.spec_json?.nodes ?? []).some((n) => n.type === "shell" && n.params?.image === im.image)).length;

const refresh = async () => {
  loading.value = true;
  try {
    const [ims, pipes] = await Promise.all([fetchImages().catch(() => []), fetchPipelines().catch(() => [])]);
    list.value = ims;
    pipelines.value = pipes;
  } finally { loading.value = false; }
};
onMounted(refresh);

const allChecked = computed(() => list.value.length > 0 && list.value.every((im) => selected.value.has(im.id)));
const toggleAll = () => { selected.value = allChecked.value ? new Set() : new Set(list.value.map((im) => im.id)); };
const toggle = (id) => {
  const s = new Set(selected.value);
  s.has(id) ? s.delete(id) : s.add(id);
  selected.value = s;
};

const goNew = () => router.push("/images/new");
const goEdit = (im) => router.push(`/images/${im.id}`);

const askDelete = (im) => {
  confirm.value = { open: true, ids: [im.id], message: `确定删除镜像「${im.name}」吗？`, detail: "引用该镜像的 shell 节点将无法再使用。" };
};
const askBatchDelete = () => {
  confirm.value = { open: true, ids: [...selected.value], message: `确定删除选中的 ${selected.value.size} 个镜像吗？`, detail: "引用它们的 shell 节点将无法再使用。" };
};
const doDelete = async () => {
  const ids = confirm.value.ids;
  deleting.value = true;
  try {
    for (const id of ids) await deleteImage(id);
    ids.forEach((id) => selected.value.delete(id));
    notify({ type: "success", message: `已删除 ${ids.length} 个镜像` });
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
        <h1 class="lp-title display">镜像</h1>
        <p class="lp-sub muted">为 shell 节点提供的运行环境，由平台统一维护、可自建扩展。</p>
      </div>
      <div class="lp-actions">
        <span class="lp-count mono">{{ list.length }} 个</span>
        <button class="btn" @click="refresh" :disabled="loading">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>
          刷新
        </button>
        <button class="btn btn-accent" @click="goNew">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          新建镜像
        </button>
      </div>
    </header>

    <Transition name="cd" appear>
      <div v-if="selected.size" class="batchbar">
        <span class="batchbar-count">已选择 <b>{{ selected.size }}</b> 个</span>
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
        <svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.2 6.1l-8-3.6a2 2 0 0 0-1.6 0l-8 3.6A2 2 0 0 0 1.5 8v8a2 2 0 0 0 1.3 1.9l8 3.6a2 2 0 0 0 1.6 0l8-3.6a2 2 0 0 0 1.3-1.9V8a2 2 0 0 0-1.5-1.9zM2 8l10 4.5L22 8M12 12.5V21"/></svg>
        <p class="dim">暂无镜像，点击右上角「新建镜像」开始。</p>
      </div>

      <div v-else class="twrap">
        <table class="dtable">
          <thead>
            <tr>
              <th class="col-check"><input class="row-check" type="checkbox" :checked="allChecked" @change="toggleAll" aria-label="全选" /></th>
              <th class="mono">名称</th>
              <th class="mono">镜像</th>
              <th class="mono">类别</th>
              <th class="mono">来源</th>
              <th class="mono">引用流水线</th>
              <th class="mono col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="im in list" :key="im.id" :class="{ sel: selected.has(im.id) }">
              <td class="col-check"><input class="row-check" type="checkbox" :checked="selected.has(im.id)" @change="toggle(im.id)" @click.stop :aria-label="`选择 ${im.name}`" /></td>
              <td>
                <div class="cell-main">
                  <span class="link-strong" @click="goEdit(im)">{{ im.name }}</span>
                  <span class="cell-sub">#{{ String(im.id).padStart(4, "0") }}</span>
                </div>
              </td>
              <td class="cell-mono" style="word-break:break-all">{{ im.image }}</td>
              <td><span class="badge badge-info">{{ im.category || "通用" }}</span></td>
              <td>
                <span v-if="im.builtin" class="badge badge-neutral">平台内建</span>
                <span v-else class="cell-mono dim">自定义</span>
              </td>
              <td>
                <a v-if="usedCount(im) > 0" class="link" @click="router.push(`/pipelines?image=${encodeURIComponent(im.image)}`)">{{ usedCount(im) }} 条 →</a>
                <span v-else class="cell-mono dim">—</span>
              </td>
              <td class="col-actions">
                <div class="cell-actions">
                  <button class="act-btn" @click="goEdit(im)">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
                    编辑
                  </button>
                  <button class="act-btn danger" @click="askDelete(im)">
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
      title="删除镜像"
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