<!-- 镜像新建/编辑页 -->
<script setup>
import { ref, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { notify } from "../lib/notify.js";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { fetchImages, createImage, updateImage, deleteImage } from "../api/image.js";

const route = useRoute();
const router = useRouter();

const form = ref({ name: "", image: "", category: "通用", builtin: false });
const loading = ref(false);
const saving = ref(false);
const deleting = ref(false);
const confirmDel = ref(false);

const isNew = computed(() => !route.params.id);
const pageTitle = computed(() => (isNew.value ? "新建镜像" : `编辑镜像${form.value.name ? " · " + form.value.name : ""}`));

const save = async () => {
  if (!form.value.name.trim()) { notify({ type: "error", message: "请填写镜像名称" }); return; }
  if (!form.value.image.trim()) { notify({ type: "error", message: "请填写镜像地址" }); return; }
  saving.value = true;
  try {
    if (route.params.id) await updateImage(+route.params.id, form.value);
    else await createImage(form.value);
    notify({ type: "success", message: "已保存镜像 ✓" });
    router.push("/images");
  } catch { /* 全局拦截器提示 */ }
  finally { saving.value = false; }
};

const doDelete = async () => {
  deleting.value = true;
  try {
    await deleteImage(+route.params.id);
    notify({ type: "success", message: "已删除镜像" });
    router.push("/images");
  } catch { /* 全局拦截器提示 */ }
  finally { deleting.value = false; }
};

onMounted(async () => {
  loading.value = true;
  try {
    if (route.params.id) {
      const im = (await fetchImages().catch(() => []))?.find((x) => x.id === +route.params.id);
      if (im) form.value = { name: im.name, image: im.image, category: im.category || "通用", builtin: !!im.builtin };
    }
  } finally { loading.value = false; }
});
</script>

<template>
  <div class="form-page">
    <header class="lp-head rise">
      <div class="title-wrap">
        <button class="btn btn-ghost" @click="router.push('/images')">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          返回列表
        </button>
        <div>
          <h1 class="lp-title display">{{ pageTitle }}</h1>
          <p class="lp-sub muted">为 shell 节点提供可执行命令的运行环境。</p>
        </div>
      </div>
    </header>

    <section v-if="loading" class="card empty rise">
      <p class="dim">加载中…</p>
    </section>

    <section v-else class="card form-sheet rise" style="animation-delay:.05s">
      <form @submit.prevent="save">
        <div class="form-grid">
          <div class="field">
            <label class="field-label">镜像名称</label>
            <input class="input" v-model="form.name" placeholder="如 alpine / node-20" required />
          </div>
          <div class="field">
            <label class="field-label">类别</label>
            <input class="input" v-model="form.category" placeholder="如 通用 / 构建 / 测试" />
          </div>
        </div>
        <div class="field">
          <label class="field-label">镜像地址</label>
          <input class="input mono" v-model="form.image" placeholder="如 node:20-alpine / registry.example.com/ci:latest" required />
        </div>
        <p v-if="form.builtin" class="builtin-tag mono-tag">平台内建镜像</p>

        <div class="form-footer">
          <button v-if="!isNew && !form.builtin" type="button" class="btn btn-danger" @click="confirmDel = true">删除此镜像</button>
          <span class="flex-spacer"></span>
          <button type="button" class="btn" @click="router.push('/images')">取消</button>
          <button type="submit" class="btn btn-accent" :disabled="saving">
            {{ saving ? "保存中…" : "保存镜像" }}
          </button>
        </div>
      </form>
    </section>

    <ConfirmDialog
      v-model:open="confirmDel"
      title="删除镜像"
      :message="`确定删除镜像「${form.name}」吗？`"
      detail="引用该镜像的 shell 节点将无法再使用。"
      :loading="deleting"
      @close="confirmDel = false"
      @confirm="doDelete"
    />
  </div>
</template>

<style scoped>
.title-wrap { display: flex; align-items: flex-end; gap: 14px; }
.builtin-tag {
  display: inline-block; margin: -6px 0 14px;
  color: var(--text-2); background: var(--bg-1);
  border: 1px solid var(--line); border-radius: 100px; padding: 4px 10px;
}
.form-footer { display: flex; align-items: center; gap: 10px; }
.flex-spacer { flex: 1; }
</style>