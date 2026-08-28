<!-- 凭证新建/编辑页 -->
<script setup>
import { ref, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { notify } from "../lib/notify.js";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { fetchCredentials, getCredential, createCredential, updateCredential, deleteCredential } from "../api/credential.js";
import { CRED_KINDS, credKind, credKindLabel } from "../lib/kinds.js";

const route = useRoute();
const router = useRouter();

const form = ref({ name: "", kind: "dingtalk-robot", secret: {} });
const loading = ref(false);
const saving = ref(false);
const deleting = ref(false);
const confirmDel = ref(false);

const isNew = computed(() => !route.params.id);
const pageTitle = computed(() => (isNew.value ? "新建凭证" : `编辑凭证${form.value.name ? " · " + form.value.name : ""}`));

const kindMeta = computed(() => credKind(form.value.kind));
const kindFields = computed(() => kindMeta.value?.fields ?? []);

// 详情接口优先；后端尚未发布详情接口(404)时回退列表查找，保证返显可用
async function loadForm() {
  const id = +route.params.id;
  let c = null;
  try { c = await getCredential(id); }
  catch (e) {
    if (e?.status !== 404) { notify({ type: "error", message: e?.message || "加载凭证失败" }); return; }
    c = null;
  }
  if (!c) c = (await fetchCredentials().catch(() => []))?.find((x) => Number(x.id) === id);
  if (c) form.value = { name: c.name, kind: c.kind, secret: {} };
  else notify({ type: "error", message: "未找到该凭证，可能已被删除" });
}

onMounted(async () => {
  loading.value = true;
  try { if (!isNew.value) await loadForm(); }
  finally { loading.value = false; }
});

const save = async () => {
  if (!form.value.name.trim()) { notify({ type: "error", message: "请填写凭证名称" }); return; }
  saving.value = true;
  try {
    if (route.params.id) await updateCredential(+route.params.id, form.value);
    else await createCredential(form.value);
    notify({ type: "success", message: "已保存凭证 ✓" });
    router.push("/credentials");
  } catch { /* 全局拦截器提示 */ }
  finally { saving.value = false; }
};

const doDelete = async () => {
  deleting.value = true;
  try {
    await deleteCredential(+route.params.id);
    notify({ type: "success", message: "已删除凭证" });
    router.push("/credentials");
  } catch { /* 全局拦截器提示 */ }
  finally { deleting.value = false; }
};
</script>

<template>
  <div class="form-page">
    <header class="lp-head rise">
      <div class="title-wrap">
        <button class="btn btn-ghost" @click="router.push('/credentials')">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          返回列表
        </button>
        <div>
          <h1 class="lp-title display">{{ pageTitle }}</h1>
          <p class="lp-sub muted">密钥以 SM4 加密后落库，敏感字段仅保存一次、不可回显。</p>
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
            <label class="field-label">凭证名称</label>
            <input class="input" v-model="form.name" placeholder="如 demo-robot / prod-registry" required />
          </div>
          <div class="field">
            <label class="field-label">凭证类型</label>
            <select class="select" v-model="form.kind">
              <option v-for="k in CRED_KINDS" :key="k.value" :value="k.value">{{ k.label }}</option>
            </select>
          </div>
        </div>

        <p class="kind-hint">{{ kindMeta?.hint }}</p>

        <div class="field" v-for="f in kindFields" :key="f.k">
          <label class="field-label">{{ f.label }}</label>
          <input
            class="input"
            :type="f.secret ? 'password' : 'text'"
            v-model="form.secret[f.k]"
            :placeholder="isNew ? f.ph : (f.secret ? '留空则保持不变（仅展示一次）' : f.ph)"
          />
        </div>

        <div class="form-footer">
          <button v-if="!isNew" type="button" class="btn btn-danger" @click="confirmDel = true">删除此凭证</button>
          <span class="flex-spacer"></span>
          <button type="button" class="btn" @click="router.push('/credentials')">取消</button>
          <button type="submit" class="btn btn-accent" :disabled="saving">
            {{ saving ? "保存中…" : "保存凭证" }}
          </button>
        </div>
      </form>
    </section>

    <ConfirmDialog
      v-model:open="confirmDel"
      title="删除凭证"
      :message="`确定删除凭证「${form.name}」吗？`"
      detail="引用该凭证的审批节点将无法再正常发送审批卡片。"
      :loading="deleting"
      @close="confirmDel = false"
      @confirm="doDelete"
    />
  </div>
</template>

<style scoped>
.title-wrap { display: flex; align-items: flex-end; gap: 14px; }
.kind-hint {
  margin: -4px 0 16px; font-size: 12.5px; line-height: 1.6;
  color: var(--text-2); background: var(--bg-1);
  border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px;
}
.form-footer { display: flex; align-items: center; gap: 10px; }
.flex-spacer { flex: 1; }
</style>