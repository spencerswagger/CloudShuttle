<!-- 凭证新建/编辑页 -->
<script setup>
import { ref, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { notify } from "../lib/notify.js";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { getCredential, createCredential, updateCredential, deleteCredential } from "../api/credential.js";
import { CRED_KINDS, credKind, credKindLabel } from "../lib/kinds.js";

const route = useRoute();
const router = useRouter();

const form = ref({ name: "", kind: "dingtalk-corp", secret: {} });
const loading = ref(false);
const saving = ref(false);
const deleting = ref(false);
const confirmDel = ref(false);

const isNew = computed(() => !route.params.id);
const pageTitle = computed(() => (isNew.value ? "新建凭证" : `编辑凭证${form.value.name ? " · " + form.value.name : ""}`));

const kindMeta = computed(() => credKind(form.value.kind));
const kindFields = computed(() => kindMeta.value?.fields ?? []);
const isDingtalk = computed(() => form.value.kind === "dingtalk-corp");

// 详情接口加载返显；失败（含 404/已被删除）统一提示
async function loadForm() {
  const id = +route.params.id;
  try {
    const c = await getCredential(id);
    form.value = { name: c.name, kind: c.kind, secret: {} };
  } catch (e) {
    notify({ type: "error", message: e?.status === 404 ? "未找到该凭证，可能已被删除" : (e?.message || "加载凭证失败") });
  }
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

        <!-- 钉钉：后台需手动完成的配置步骤 + 跳转链接 -->
        <section v-if="kindMeta?.guide?.length" class="enroll-card">
          <div class="enroll-title">钉钉后台需完成的配置</div>
          <ol class="enroll-steps">
            <li v-for="(g, i) in kindMeta.guide" :key="i" class="enroll-step">
              <div class="enroll-step-head">
                <span class="enroll-step-no">{{ i + 1 }}</span>
                <a :href="g.url" target="_blank" rel="noreferrer" class="enroll-link">
                  <span class="enroll-link-name">{{ g.title }}</span>
                  <span class="enroll-go">去配置 ↗</span>
                </a>
              </div>
              <p class="enroll-step-text">{{ g.text }}</p>
            </li>
          </ol>
        </section>

        <!-- 钉钉：后台自动生成/推导的参数说明 -->
        <section v-if="kindMeta?.auto?.length" class="enroll-auto">
          <div class="enroll-title">自动生成（无需填写）</div>
          <div v-for="(a, i) in kindMeta.auto" :key="i" class="enroll-auto-row">
            <span class="enroll-auto-label">{{ a.label }}</span>
            <span class="enroll-auto-value">{{ a.value }}</span>
          </div>
        </section>

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
  {{ saving ? (isDingtalk ? "正在校验钉钉配置…" : "保存中…") : (isDingtalk ? "校验并保存" : "保存凭证") }}
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
.enroll-card { margin: 0 0 18px; border: 1px solid var(--line); border-radius: 12px; background: var(--bg-1); padding: 14px 16px; }
.enroll-title { font-size: 12.5px; font-weight: 600; letter-spacing: .3px; margin-bottom: 10px; color: var(--text-1); }
.enroll-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.enroll-step-head { display: flex; align-items: center; gap: 10px; }
.enroll-step-no { width: 18px; height: 18px; border-radius: 50%; background: var(--accent); color: #04121a; font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.enroll-link { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; color: var(--text-1); font-weight: 600; font-size: 13px; }
.enroll-link:hover { color: var(--accent); }
.enroll-go { margin-left: auto; font-size: 11.5px; color: var(--accent); flex: none; }
.enroll-step-text { margin: 4px 0 0 28px; font-size: 12px; line-height: 1.6; color: var(--text-2); }
.enroll-auto { border: 1px dashed var(--line); border-radius: 12px; padding: 10px 14px; margin: 0 0 18px; background: var(--bg-1); }
.enroll-auto-row { display: flex; gap: 10px; align-items: baseline; padding: 5px 0; }
.enroll-auto-label { width: 120px; flex: none; font-size: 12px; color: var(--text-2); }
.enroll-auto-value { font-size: 12.5px; color: var(--text-1); }
</style>