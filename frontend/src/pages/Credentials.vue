<!-- frontend/src/pages/Credentials.vue -->
<script setup>
import { ref, onMounted } from "vue";
import { fetchCredentials, createCredential } from "../api/credential.js";

const list = ref([]);
const form = ref({ name: "", kind: "dingtalk-robot", secret: {} });

const KINDS = [
  {
    value: "dingtalk-robot",
    label: "钉钉审批机器人",
    fields: [
      { k: "webhook", label: "Webhook 地址", ph: "https://oapi.dingtalk.com/robot/send?access_token=..." },
      { k: "signSecret", label: "加签密钥（可选）", ph: "SEC..." },
    ],
  },
  {
    value: "docker-registry",
    label: "Docker 私有仓库",
    fields: [
      { k: "registry", label: "仓库地址", ph: "registry.example.com" },
      { k: "username", label: "账号", ph: "账号" },
      { k: "password", label: "密码 / Token", ph: "密码" },
    ],
  },
  {
    value: "s3",
    label: "S3 兼容对象存储",
    fields: [
      { k: "endpoint", label: "Endpoint", ph: "oss-cn-hangzhou.aliyuncs.com" },
      { k: "bucket", label: "Bucket", ph: "bucket" },
      { k: "ak", label: "AccessKey", ph: "AK" },
      { k: "sk", label: "SecretKey", ph: "SK" },
    ],
  },
];

const kindFields = () => KINDS.find((k) => k.value === form.value.kind)?.fields ?? [];

onMounted(async () => { list.value = await fetchCredentials(); });

const submit = async () => {
  await createCredential(form.value);
  form.value = { name: "", kind: form.value.kind, secret: {} };
  list.value = await fetchCredentials();
};
</script>
<template>
  <div>
    <h2>凭证</h2>
    <p class="hint">凭证 SM4 加密落库；approval 节点用 params.robot 引用钉钉机器人名。</p>
    <form @submit.prevent="submit">
      <input v-model="form.name" placeholder="名称（如 demo-robot）" required />
      <select v-model="form.kind">
        <option v-for="k in KINDS" :key="k.value" :value="k.value">{{ k.label }}</option>
      </select>
      <div v-for="f in kindFields()" :key="f.k">
        <label>{{ f.label }}</label>
        <input v-model="form.secret[f.k]" :placeholder="f.ph" />
      </div>
      <button>保存</button>
    </form>
    <pre>{{ list }}</pre>
  </div>
</template>
<style scoped>
.hint { color: #888; font-size: 12px; }
label { display: block; margin-top: 6px; font-size: 12px; }
input { margin: 2px 4px 4px 0; }
</style>