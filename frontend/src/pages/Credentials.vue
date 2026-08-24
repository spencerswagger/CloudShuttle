<!-- frontend/src/pages/Credentials.vue -->
<script setup>
import { ref, onMounted } from "vue";
import { fetchCredentials, createCredential } from "../api/credential.js";

const list = ref([]);
const form = ref({ name: "", kind: "dingtalk-robot", secret: {} });
const saving = ref(false);

const KINDS = [
  {
    value: "dingtalk-robot",
    label: "钉钉审批机器人",
    icon: "M17 8a5 5 0 0 0-9.5 1.9A3 3 0 1 0 5 15h14a4 4 0 0 0 0-7z",
    hint: "approval 节点通过 params.robot 引用这里创建的机器人名称",
    fields: [
      { k: "webhook", label: "Webhook 地址", ph: "https://oapi.dingtalk.com/robot/send?access_token=..." },
      { k: "signSecret", label: "加签密钥（可选）", ph: "SEC...", secret: true },
    ],
  },
  {
    value: "docker-registry",
    label: "Docker 私有仓库",
    icon: "M20 7a4 4 0 0 1-6 3.5L9 15a4 4 0 1 1-2.8-2.3L11.4 8A4 4 0 1 1 20 7zM3.5 17.5L7 21M5 19.5l-1.5-1.5",
    hint: "供 shell 节点拉取私有镜像时使用",
    fields: [
      { k: "registry", label: "仓库地址", ph: "registry.example.com" },
      { k: "username", label: "账号", ph: "账号" },
      { k: "password", label: "密码 / Token", ph: "密码", secret: true },
    ],
  },
  {
    value: "s3",
    label: "S3 兼容对象存储",
    icon: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zm-6 5l6 3.5 6-3.5M12 11.5V21",
    hint: "可用于产物归档与静态资源托管",
    fields: [
      { k: "endpoint", label: "Endpoint", ph: "oss-cn-hangzhou.aliyuncs.com" },
      { k: "bucket", label: "Bucket", ph: "bucket" },
      { k: "ak", label: "AccessKey", ph: "AK" },
      { k: "sk", label: "SecretKey", ph: "SK", secret: true },
    ],
  },
];

const kindMeta = () => KINDS.find((k) => k.value === form.value.kind);
const kindFields = () => kindMeta()?.fields ?? [];
const kindLabel = (kind) => KINDS.find((k) => k.value === kind)?.label ?? kind;

const fmtDate = (iso) =>
  new Date(iso).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

onMounted(async () => { list.value = await fetchCredentials().catch(() => []); });

const submit = async () => {
  saving.value = true;
  try {
    await createCredential(form.value);
    form.value = { name: "", kind: form.value.kind, secret: {} };
    list.value = await fetchCredentials();
  } finally {
    saving.value = false;
  }
};
</script>

<template>
  <div class="page">
    <header class="page-head rise">
      <div>
        <h1 class="head-title display">凭证</h1>
        <p class="head-sub muted">集中管理机器人、仓库与对象存储的访问密钥，落库前以 SM4 加密。</p>
      </div>
    </header>

    <div class="layout">
      <!-- 创建表单 -->
      <section class="card form-card rise" style="animation-delay:.05s">
        <div class="form-head">
          <span class="form-ico" :style="{ color: 'var(--accent)' }">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
          </span>
          <div>
            <h3 class="form-title display">新建凭证</h3>
            <p class="form-sub dim">{{ kindMeta()?.hint }}</p>
          </div>
        </div>

        <form @submit.prevent="submit" class="form">
          <div class="field">
            <label class="field-label">凭证名称</label>
            <input class="input" v-model="form.name" placeholder="如 demo-robot / prod-registry" required />
          </div>
          <div class="field">
            <label class="field-label">类型</label>
            <div class="kind-tabs">
              <button
                v-for="k in KINDS"
                type="button"
                class="kind-tab"
                :class="{ active: form.kind === k.value }"
                :key="k.value"
                @click="form.kind = k.value"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path :d="k.icon" /></svg>
                <span>{{ k.label }}</span>
              </button>
            </div>
          </div>

          <div class="fields-dyn">
            <div class="field" v-for="f in kindFields()" :key="f.k">
              <label class="field-label">{{ f.label }}</label>
              <input class="input" :type="f.secret ? 'password' : 'text'" v-model="form.secret[f.k]" :placeholder="f.ph" />
            </div>
          </div>

          <button class="btn btn-accent btn-full" :disabled="saving">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
            {{ saving ? "保存中…" : "保存凭证" }}
          </button>
        </form>
      </section>

      <!-- 凭证列表 -->
      <section class="card list-card rise" style="animation-delay:.09s">
        <div class="list-head">
          <h3 class="form-title display">已存凭证</h3>
          <span class="mono count">{{ list.length }}</span>
        </div>

        <div v-if="!list.length" class="empty" style="border-top:1px solid var(--line)">
          <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a5 5 0 0 1 5 5 3 3 0 0 1 3 3v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-3a3 3 0 0 1 2-2.8M8.5 11.5V9a3.5 3.5 0 0 1 7 0"/></svg>
          <p class="dim">还没有凭证，先创建一个。</p>
        </div>

        <ul v-else class="cred-list stagger">
          <li v-for="c in list" :key="c.id" class="cred-item">
            <span class="cred-ico">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path :d="(KINDS.find(k=>k.value===c.kind)||{}).icon || 'M12 3a5 5 0 0 1 5 5'" />
              </svg>
            </span>
            <div class="cred-info">
              <span class="cred-name">{{ c.name }}</span>
              <span class="dim mono-tag">{{ fmtDate(c.created_at) }}</span>
            </div>
            <span class="badge badge-neutral">{{ kindLabel(c.kind) }}</span>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 18px; max-width: 980px; }
.page-head { padding-bottom: 2px; }
.head-title { margin: 0; font-size: 26px; font-weight: 700; }
.head-sub { margin: 6px 0 0; font-size: 13.5px; }
.layout { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; align-items: start; }

/* 卡片头部 */
.form-card { padding: 22px; }
.list-card { padding: 22px; }
.form-head { display: flex; gap: 12px; align-items: center; margin-bottom: 18px; }
.form-ico {
  width: 36px; height: 36px; flex: 0 0 36px; display: grid; place-items: center;
  background: var(--accent-soft); border: 1px solid var(--line-strong); border-radius: 10px;
}
.form-title { margin: 0; font-size: 15px; font-weight: 700; letter-spacing: .02em; }
.form-sub { margin: 3px 0 0; font-size: 12px; line-height: 1.5; }

/* 类型切换 */
.kind-tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.kind-tab {
  display: inline-flex; align-items: center; gap: 7px;
  font-family: var(--font-display); font-size: 12.5px; font-weight: 500;
  color: var(--text-2); background: var(--bg-1);
  border: 1px solid var(--line); border-radius: 9px;
  padding: 8px 12px; cursor: pointer;
  transition: all .16s var(--ease);
}
.kind-tab:hover { color: var(--text-1); border-color: var(--line-strong); }
.kind-tab.active {
  color: var(--accent); background: var(--accent-soft); border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.fields-dyn { margin-top: 4px; }
.btn-full { width: 100%; justify-content: center; margin-top: 6px; }

/* 列表 */
.list-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.count {
  font-size: 12px; color: var(--accent);
  background: var(--accent-soft); border-radius: 100px;
  padding: 3px 10px;
}
.cred-list { list-style: none; margin: 0; padding: 0; }
.cred-item {
  display: flex; align-items: center; gap: 12px;
  padding: 13px 4px; border-bottom: 1px solid var(--line);
}
.cred-item:last-child { border-bottom: none; }
.cred-ico {
  width: 32px; height: 32px; flex: 0 0 32px; display: grid; place-items: center;
  color: var(--text-2); background: var(--bg-2); border: 1px solid var(--line);
  border-radius: 9px;
}
.cred-info { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.cred-name { font-family: var(--font-display); font-size: 13.5px; font-weight: 600; color: var(--text-1); }

@media (max-width: 860px) {
  .layout { grid-template-columns: 1fr; }
}
</style>