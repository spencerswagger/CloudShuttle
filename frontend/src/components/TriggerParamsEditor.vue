<!-- 统一 schema 编辑器：manual/webhook 触发参数与 shell 输出变量共用一份 schema（key/标题/类型/默认值/选项/必填/说明）。
     showJson=true 额外展示 JSONPath 列（Webhook tab）；showRequired=false 时隐藏必填列（如 shell 输出变量）。
     直接对传入数组做行增删与字段编辑（引用响应式）。 -->
<script setup>
import { computed } from "vue";
const props = defineProps({
  params: { type: Array, required: true }, // 引用父级响应式数组
  showJson: { type: Boolean, default: false }, // 展示 JSONPath 列
  showRequired: { type: Boolean, default: true }, // 展示必填列
});

const TYPES = ["string", "text", "number", "boolean", "enum"];
function addParam() {
  props.params.push({ key: "", title: "", type: "string", default: "", required: false, description: "", options: [], jsonPath: "" });
}
// enum 选项以逗号分隔的字符串在编辑器里编辑，实时拆分为数组落库
const optionsText = (p) => (p.options ?? []).join(", ");
function setOptions(p, ev) {
  p.options = String(ev.target.value).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
}
// 列模板随 showJson/showRequired 变化；单元格按 DOM 顺序自动落位，无需逐列定位
const headCols = computed(() => {
  if (props.showJson && props.showRequired) return ".85fr .9fr .9fr .9fr 1.1fr 44px 1.2fr 1.3fr 30px";
  if (props.showJson) return ".85fr .9fr .9fr .9fr 1.1fr 1.3fr 1.2fr 30px";
  if (props.showRequired) return ".9fr 1fr 1fr 1fr 1.3fr 44px 1.6fr 30px";
  return ".9fr 1fr 1fr 1fr 1.3fr 1.9fr 30px";
});
</script>

<template>
  <div v-if="!params.length" class="trig-empty">
    <span class="muted">{{ showJson
      ? "尚未配置触发参数，Webhook 触发不会注入变量（manual 触发将直接运行）。"
      : "尚未声明输出变量，脚本可通过 echo \"key=value\" 写回变量供后续节点使用。" }}</span>
    <button type="button" class="btn btn-sm btn-ghost" @click="addParam">＋ 添加</button>
  </div>
  <div v-else class="param-list">
    <div class="param-row param-head" :style="{ gridTemplateColumns: headCols }">
      <span class="param-cell">key</span>
      <span class="param-cell">标题</span>
      <span class="param-cell">类型</span>
      <span class="param-cell">默认值</span>
      <span class="param-cell">选项</span>
      <span v-if="showRequired" class="param-cell req-col">必填</span>
      <span class="param-cell">说明</span>
      <span v-if="showJson" class="param-cell">JSONPath</span>
      <span class="param-cell del-col"> </span>
    </div>
    <div v-for="(p, i) in params" :key="i" class="param-row" :style="{ gridTemplateColumns: headCols }">
      <div class="param-cell">
        <input class="input mono" v-model="p.key" placeholder="branch" />
      </div>
      <div class="param-cell">
        <input class="input" v-model="p.title" placeholder="分支" />
      </div>
      <div class="param-cell">
        <select class="select" v-model="p.type">
          <option v-for="t in TYPES" :key="t" :value="t">{{ t }}</option>
        </select>
      </div>
      <div class="param-cell">
        <select v-if="p.type === 'boolean'" class="select" v-model="p.default">
          <option value="">默认</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
        <input v-else class="input" v-model="p.default" placeholder="main" />
      </div>
      <div class="param-cell">
        <input v-if="p.type === 'enum'" class="input mono" :value="optionsText(p)" @input="setOptions(p, $event)" placeholder="a, b, c（逗号分隔）" />
        <span v-else class="muted">—</span>
      </div>
      <div v-if="showRequired" class="param-cell req-col">
        <input class="row-check" type="checkbox" v-model="p.required" title="必填" />
      </div>
      <div class="param-cell">
        <input class="input" v-model="p.description" placeholder="要发布的 Git 分支 / 输出含义" />
      </div>
      <div v-if="showJson" class="param-cell">
        <input class="input mono" v-model="p.jsonPath" placeholder="$.ref（从 Webhook 请求体取值）" />
      </div>
      <div class="param-cell del-col">
        <button type="button" class="btn btn-sm btn-danger" title="删除" @click="params.splice(i, 1)">×</button>
      </div>
    </div>
    <div class="trig-acts">
      <button type="button" class="btn btn-sm btn-ghost" @click="addParam">＋ 添加</button>
    </div>
  </div>
</template>

<style scoped>
/* 统一 schema 表：样式随组件自带，避免依赖父作用域失效（scoped 不穿透）。
   单元格按 DOM 顺序自动落位到 gridTemplateColumns，由调用方（headCols）决定刻画列数。 */
.trig-empty {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  padding: 14px 16px; border: 1px dashed var(--line-strong); border-radius: 9px; font-size: 12.5px;
}
.param-list { display: flex; flex-direction: column; gap: 8px; }
.param-row { display: grid; gap: 10px; align-items: center; }
.param-row.param-head {
  font-family: var(--font-mono); font-size: 11.5px; font-weight: 700; letter-spacing: .05em;
  text-transform: uppercase; color: var(--text-2); padding: 2px 2px 0;
}
.param-row:not(.param-head) { min-width: 0; }
.param-row:not(.param-head) .param-cell { min-width: 0; }
.param-cell.req-col { text-align: center; display: flex; justify-content: center; align-items: center; }
.param-cell.del-col { text-align: center; display: flex; justify-content: center; align-items: center; }
.trig-acts { display: flex; justify-content: flex-end; margin-top: 4px; }
@media (max-width: 1080px) {
  .param-row:not(.param-head) { grid-template-columns: 1fr 1fr !important; }
  .param-row.param-head { display: none; }
}
</style>