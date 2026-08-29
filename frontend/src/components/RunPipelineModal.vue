<!-- 运行流水线弹窗：按 manual 触发 schema 渲染表单；无 manual 参数时静默直达触发。
     PipelineEdit / PipelineList 复用，暴露 open(pipeline) 方法。 -->
<script setup>
import { ref, reactive, computed } from "vue";
import { runPipeline } from "../api/pipeline.js";
import { notify } from "../lib/notify.js";

const open = ref(false);
const pipeline = ref(null);
const form = reactive({});
const errs = reactive({});
const submitting = ref(false);

const params = computed(() => pipeline.value?.spec_json?.trigger?.manual?.params ?? []);

// 判定某参数当前取值是否「为空」（用于必填校验与缺省回退）
const isEmpty = (v) => v === undefined || v === null || v === "";

function initForm() {
  for (const k of Object.keys(form)) delete form[k];
  for (const k of Object.keys(errs)) delete errs[k];
  for (const p of params.value) {
    if (p.type === "boolean") {
      form[p.key] = p.default === true || String(p.default) === "true";
    } else if (p.type === "enum") {
      form[p.key] = isEmpty(p.default) ? "" : p.default;
    } else {
      form[p.key] = isEmpty(p.default) ? "" : p.default;
    }
  }
}

// 无 manual 参数：直接触发的公共函数（供 modal 内部与暴露的 open 复用）
function runDirect() {
  submitting.value = true;
  return runPipeline(pipeline.value?.id)
    .then(() => {
      notify({ type: "success", message: `已触发运行「${pipeline.value?.name ?? ""}」，可去执行页查看` });
    })
    .catch(() => { /* 全局拦截器提示 */ })
    .finally(() => { submitting.value = false; });
}

/** 统一运行入口：有 manual 参数则弹表单，否则直接触发 */
function openFor(p) {
  pipeline.value = p;
  initForm();
  if (params.value.length) open.value = true;
  else runDirect();
}

function close() { open.value = false; }

async function submit() {
  const e = {};
  let invalid = false;
  for (const p of params.value) {
    if (p.required && isEmpty(form[p.key])) {
      e[p.key] = `「${p.title || p.key}」为必填项`;
      invalid = true;
    }
  }
  for (const k of Object.keys(errs)) delete errs[k];
  Object.assign(errs, e);
  if (invalid) { notify({ type: "error", message: "请先完善必填参数" }); return; }

  const out = {};
  for (const p of params.value) {
    const k = p.key;
    let v = form[k];
    if (p.type === "boolean") {
      out[k] = !!v;
    } else if (p.type === "number") {
      out[k] = isEmpty(v) ? (isEmpty(p.default) ? "" : String(p.default)) : String(v);
    } else {
      out[k] = isEmpty(v) ? (isEmpty(p.default) ? "" : String(p.default)) : String(v);
    }
  }
  submitting.value = true;
  try {
    await runPipeline(pipeline.value?.id, { params: out });
    notify({ type: "success", message: `已触发运行「${pipeline.value?.name ?? ""}」，可去执行页查看` });
    open.value = false;
  } catch { /* 全局拦截器提示 */ }
  finally { submitting.value = false; }
}

defineExpose({ open: openFor, state: submitting });
</script>

<template>
  <div v-if="open" class="run-mask" @click.self="close">
    <div class="run-panel">
      <div class="run-head">
        <strong class="run-title display">运行流水线 · {{ pipeline?.name }}</strong>
        <button type="button" class="btn btn-ghost" @click="close" aria-label="关闭">×</button>
      </div>

      <div class="run-body">
        <p class="run-desc muted">按 manual 触发的 schema 填写参数，提交后将作为执行期变量注入，可用 <code class="mono">${key}</code> 引用。</p>

        <div v-for="p in params" :key="p.key" class="field run-field">
          <label class="field-label">
            {{ p.title || p.key }}
            <span v-if="p.required" class="req" title="必填">*</span>
          </label>

          <textarea v-if="p.type === 'text'" class="textarea" v-model="form[p.key]" rows="2" :placeholder="p.default || '填写值'"></textarea>

          <input v-else-if="p.type === 'number'" class="input" type="number" v-model="form[p.key]" :placeholder="isEmpty(p.default) ? '填写数字' : String(p.default)" />

          <label v-else-if="p.type === 'boolean'" class="switch">
            <input type="checkbox" v-model="form[p.key]" />
            <span class="switch-slider"></span>
          </label>

          <select v-else-if="p.type === 'enum'" class="select" v-model="form[p.key]">
            <option v-if="!isEmpty(p.default)" :value="String(p.default)">{{ String(p.default) }}</option>
            <option v-for="op in p.options || []" :key="op" :value="String(op)">{{ op }}</option>
            <option v-if="(p.options || []).length === 0 && isEmpty(p.default)" value="" disabled>暂无可用选项</option>
          </select>

          <input v-else class="input" v-model="form[p.key]" :placeholder="isEmpty(p.default) ? '' : String(p.default)" />

          <p v-if="p.type === 'enum' && (p.options || []).length === 0 && isEmpty(p.default)" class="field-hint err-hint">该参数未配置可选项，请先在编辑页补充 options。</p>
          <p v-if="p.description" class="field-hint">{{ p.description }}</p>
          <p v-if="errs[p.key]" class="field-hint err-hint">{{ errs[p.key] }}</p>
        </div>
      </div>

      <div class="run-foot">
        <button type="button" class="btn btn-ghost" @click="close">取消</button>
        <button type="button" class="btn btn-accent" :disabled="submitting" @click="submit">
          {{ submitting ? "提交中…" : "触发运行" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.run-mask { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; animation: runFade .18s var(--ease) both; }
.run-panel { width: 520px; max-width: 92vw; max-height: 84vh; background: var(--bg-2); border: 1px solid var(--line-strong); border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; }
.run-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.run-title { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-body { padding: 14px 18px; overflow: auto; flex: 1; }
.run-desc { font-size: 12.5px; margin: 0 0 14px; line-height: 1.5; }
.run-desc code { font-size: 11.5px; color: var(--accent); background: var(--accent-soft); padding: 1px 5px; border-radius: 5px; }
.run-field { margin-bottom: 14px; }
.run-field:last-child { margin-bottom: 0; }
.req { color: var(--err); margin-left: 3px; }
.err-hint { color: var(--err); }
.switch { position: relative; display: inline-block; width: 40px; height: 22px; }
.switch input { opacity: 0; width: 0; height: 0; }
.switch-slider {
  position: absolute; inset: 0; cursor: pointer; border-radius: 100px;
  background: var(--bg-3); border: 1px solid var(--line-strong); transition: all .18s var(--ease);
}
.switch-slider::before {
  content: ""; position: absolute; height: 14px; width: 14px; left: 3px; top: 3px;
  background: var(--text-3); border-radius: 50%; transition: transform .18s var(--ease), background .18s var(--ease);
}
.switch input:checked + .switch-slider { background: var(--accent-soft); border-color: var(--accent); }
.switch input:checked + .switch-slider::before { transform: translateX(18px); background: var(--accent); }
.run-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); }
@keyframes runFade { from { opacity: 0; } to { opacity: 1; } }
</style>