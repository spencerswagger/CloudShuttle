<!-- 统一触发参数编辑器：manual 与 webhook 共用一份 params（key/标题/类型/默认值/选项/必填/说明），
     showJson=true 时（Webhook tab）额外展示 JSONPath 列。直接对传入数组做行增删与字段编辑（引用响应式）。 -->
<script setup>
const props = defineProps({
  params: { type: Array, required: true }, // spec_json.trigger.params 的引用（父级响应式对象）
  showJson: { type: Boolean, default: false },
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
</script>

<template>
  <div v-if="!params.length" class="trig-empty">
    <span class="muted">{{ showJson ? "尚未配置触发参数，Webhook 触发不会注入变量（manual 触发将直接运行）。" : "尚未配置触发参数，手动运行时将直接触发。" }}</span>
    <button type="button" class="btn btn-sm btn-ghost" @click="addParam">＋ 添加参数</button>
  </div>
  <div v-else class="param-list">
    <div class="param-row param-head" :class="{ withJson: showJson }">
      <span class="param-cell key">key</span>
      <span class="param-cell title">标题</span>
      <span class="param-cell type">类型</span>
      <span class="param-cell default">默认值</span>
      <span class="param-cell options">选项</span>
      <span class="param-cell req">必填</span>
      <span class="param-cell desc">说明</span>
      <span v-if="showJson" class="param-cell json">JSONPath</span>
      <span class="param-cell del"> </span>
    </div>
    <div v-for="(p, i) in params" :key="i" class="param-row" :class="{ withJson: showJson }">
      <div class="param-cell key">
        <input class="input mono" v-model="p.key" placeholder="branch" />
      </div>
      <div class="param-cell title">
        <input class="input" v-model="p.title" placeholder="分支" />
      </div>
      <div class="param-cell type">
        <select class="select" v-model="p.type">
          <option v-for="t in TYPES" :key="t" :value="t">{{ t }}</option>
        </select>
      </div>
      <div class="param-cell default">
        <select v-if="p.type === 'boolean'" class="select" v-model="p.default">
          <option value="">默认</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
        <input v-else class="input" v-model="p.default" placeholder="main" />
      </div>
      <div class="param-cell options">
        <input v-if="p.type === 'enum'" class="input mono" :value="optionsText(p)" @input="setOptions(p, $event)" placeholder="a, b, c（逗号分隔）" />
        <span v-else class="muted">—</span>
      </div>
      <div class="param-cell req">
        <input class="row-check" type="checkbox" v-model="p.required" title="必填" />
      </div>
      <div class="param-cell desc">
        <input class="input" v-model="p.description" placeholder="要发布的 Git 分支" />
      </div>
      <div v-if="showJson" class="param-cell json">
        <input class="input mono" v-model="p.jsonPath" placeholder="$.ref（从 Webhook 请求体取值）" />
      </div>
      <div class="param-cell del">
        <button type="button" class="btn btn-sm btn-danger" title="删除该参数" @click="params.splice(i, 1)">×</button>
      </div>
    </div>
    <div class="trig-acts">
      <button type="button" class="btn btn-sm btn-ghost" @click="addParam">＋ 添加参数</button>
    </div>
  </div>
</template>
