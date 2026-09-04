<!-- 执行详情页：调度日志 + 步骤手风琴（单开）。步骤头展示节点名称/类型/状态/开始时间，
     悬停显示开始-结束-时长；展开区展示节点配置、审批内容与接收人、执行日志、节点输出。 -->
<script setup>
import { ref, computed, watch, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import MarkdownIt from "markdown-it";
import { getExecution, cancelExecution, rerunExecution } from "../api/execution.js";
import { notify } from "../lib/notify.js";

const route = useRoute();
const router = useRouter();

const exec = ref(null);
const loading = ref(true);
const acting = ref(false);

const STATUS = {
  queued:    { label: "排队中", cls: "badge-neutral", dot: "var(--text-3)" },
  running:   { label: "运行中", cls: "badge-info",     dot: "var(--info)" },
  succeeded: { label: "成功",   cls: "badge-ok",       dot: "var(--ok)" },
  done:      { label: "完成",   cls: "badge-ok",       dot: "var(--ok)" },
  failed:    { label: "失败",   cls: "badge-err",      dot: "var(--err)" },
  rejected:  { label: "已拒绝", cls: "badge-err",      dot: "var(--err)" },
  cancelled: { label: "已取消", cls: "badge-neutral",  dot: "var(--text-3)" },
  approve:   { label: "审批中", cls: "badge-warn",     dot: "var(--warn)" },
  eci:       { label: "运行中", cls: "badge-info",     dot: "var(--info)" },
};

const meta = computed(() => STATUS[exec.value?.status] || { label: exec.value?.status ?? "—", cls: "badge-neutral", dot: "var(--text-3)" });
const cancellable = computed(() => ["queued", "running"].includes(exec.value?.status));

// 触发来源：数据库存英文，界面统一中文
const TRIGGER_LABEL = { manual: "手动触发", webhook: "Webhook 触发", api: "API 触发", cron: "定时触发" };
const triggerLabel = computed(() => {
  const t = exec.value?.trigger;
  if (!t) return "API 触发";
  return TRIGGER_LABEL[t.trigger || t.source || t.via] || "API 触发";
});
const triggerPayload = computed(() => {
  const t = exec.value?.trigger;
  if (!t) return null;
  return t.trigger === "webhook" ? t.body ?? {} : t.params ?? {};
});

const fmt = (iso) => iso ? new Date(iso).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
const fmtShort = (iso) => iso ? new Date(iso).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
const durText = (a, b) => {
  if (!a || !b) return "";
  const ms = new Date(b) - new Date(a);
  if (ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
};

// 节点类型：execution_node.type 可能为空（历史数据），用 stepType（后端并入）与 params 形状推断兜底
const effType = (s) => s.type || s.stepType || (s.params ? (s.params.command ? "shell" : s.params.message || s.params.robot ? "approval" : "") : "");
const KIND_LABEL = { shell: "Shell 执行", approval: "人工审批" };
const KIND_ACCENT = { shell: "var(--accent)", approval: "var(--ember)" };
const kindLabel = (s) => KIND_LABEL[effType(s)] || effType(s) || "节点";
const kindAccent = (s) => KIND_ACCENT[effType(s)] || "var(--text-2)";

const statusLabel = (s) => STATUS[s.status]?.label || s.status || "—";
const statusCls = (s) => STATUS[s.status]?.cls || "badge-neutral";
const statusDot = (s) => STATUS[s.status]?.dot || "var(--text-3)";
const hasOutput = (s) => s.output && typeof s.output === "object" && Object.keys(s.output).length > 0;

// 步骤列表（后端已并入 name/params/时间列）
const steps = computed(() => {
  const s = exec.value?.steps;
  return Array.isArray(s) ? s : [];
});
// 触发源作为固定首项展示（不算 STEP 序号）
const triggerStep = computed(() => exec.value?.trigger ? {
  kind: "trigger", status: "", name: "", started_at: exec.value?.started_at,
} : null);
const displaySteps = computed(() => (triggerStep.value ? [triggerStep.value, ...steps.value] : steps.value));

const stepTitle = (s) => {
  if (s.kind === "trigger") return triggerLabel.value;
  return s.name || KIND_LABEL[effType(s)] || "节点";
};
const stepSub = (s) => {
  if (s.kind === "trigger") return "点开查看本次触发输入";
  const p = s.params;
  const t = effType(s);
  const parts = [];
  if (t === "shell") {
    if (p?.image) parts.push(`镜像 ${p.image}`);
    if (p?.cpu || p?.memory) parts.push(`${p?.cpu || "?"} vCPU · ${p?.memory || "?"} GiB`);
    if (p?.regionId) parts.push(p.regionId);
    if (!parts.length) parts.push("运行 Shell 命令");
  } else if (t === "approval") {
    if (p?.robot) parts.push(`载体 ${p.robot}`);
    if (!parts.length) parts.push("人工审批请求");
  }
  return parts.join(" · ");
};
const stepTimeTip = (s) => {
  if (s.kind === "trigger") return `创建/开始 ${fmt(s.started_at) || "—"}`;
  const lines = [];
  if (s.started_at) lines.push(`开始 ${fmt(s.started_at)}`);
  if (s.finished_at) lines.push(`结束 ${fmt(s.finished_at)}`);
  if (s.started_at && s.finished_at) lines.push(`时长 ${durText(s.started_at, s.finished_at)}`);
  if (!lines.length) lines.push("未记录时间");
  return lines.join("\n");
};

// 手风琴：单开 —— 展开一个步骤时收起其他；默认展开首个非终态/失败步骤
const opened = ref(null); // displaySteps 下标；null=全部收起
const AUTO_OPEN = ["running", "eci", "approve", "failed", "rejected"];
let initialized = false;
watch(displaySteps, () => {
  if (initialized) return;
  initialized = true;
  const idx = displaySteps.value.findIndex((s) => AUTO_OPEN.includes(s.status));
  opened.value = idx > 0 ? idx : null; // 触发源（idx 0）不默认展开
});
const toggleStep = (i) => { opened.value = opened.value === i ? null : i; };

const approvalText = (s) => {
  const p = s.params;
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
  return p?.message ? md.render(String(p.message)) : "";
};
const approvalTargets = (s) => {
  const p = s.params;
  const out = [];
  if (p?.target?.openIds) out.push(...String(p.target.openIds).split(/[,，]/).map((x) => x.trim()).filter(Boolean));
  if (Array.isArray(p?.target?.members)) {
    for (const m of p.target.members) {
      if (m?.name) out.push(m.name);
      else if (m?.userid) out.push(m.userid);
    }
  }
  return out;
};

const refresh = async () => {
  loading.value = true;
  try { exec.value = await getExecution(+route.params.id); }
  catch { /* 全局拦截器提示，停留在空态 */ }
  finally { loading.value = false; }
};
onMounted(refresh);

const cancel = async () => {
  acting.value = true;
  try { await cancelExecution(+route.params.id); notify({ type: "success", message: "已终止执行" }); await refresh(); }
  catch { /* 全局拦截器提示 */ }
  finally { acting.value = false; }
};
const rerun = async () => {
  acting.value = true;
  try { await rerunExecution(+route.params.id); notify({ type: "success", message: "已重新触发" }); await refresh(); }
  catch { /* 全局拦截器提示 */ }
  finally { acting.value = false; }
};
</script>

<template>
  <div class="form-page">
    <header class="lp-head rise">
      <div class="title-wrap">
        <button class="btn btn-ghost" @click="router.push('/executions')">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          返回列表
        </button>
        <div class="head-main">
          <h1 class="lp-title display">
            执行详情 · #{{ String(exec?.id ?? "").padStart(4, "0") }}
            <span class="badge head-badge" :class="meta.cls" :style="{ '--dot': meta.dot }">{{ meta.label }}</span>
          </h1>
          <p class="lp-sub muted">
            {{ triggerLabel }}<template v-if="exec?.pipeline_id"> · </template>
            <template v-if="exec?.pipeline_id"><a class="link-strong" @click="router.push(`/pipelines/${exec.pipeline_id}`)">{{ exec.pipeline_name ?? ("流水线 #" + exec.pipeline_id) }}</a></template>
            <template v-if="fmt(exec?.started_at)"> · 创建于 {{ fmt(exec.started_at) }}</template>
          </p>
        </div>
      </div>
      <div class="lp-actions">
        <button v-if="cancellable" class="btn btn-danger" :disabled="acting" @click="cancel">终止执行</button>
        <button class="btn btn-accent" :disabled="acting" @click="rerun">重新触发</button>
      </div>
    </header>

    <section v-if="loading" class="card empty rise"><p class="dim">加载中…</p></section>

    <template v-else-if="exec">
      <!-- 调度日志：非节点执行日志，记录流水线调度全过程 -->
      <section class="card log-card rise" style="animation-delay:.05s">
        <h3 class="block-title display">调度日志</h3>
        <div v-if="Array.isArray(exec.schedules) && exec.schedules.length" class="sched-list">
          <div v-for="(l, i) in exec.schedules" :key="i" class="sched-row">
            <span class="sched-ts mono">{{ fmtShort(l.ts) }}</span>
            <span class="sched-msg">{{ l.message }}</span>
          </div>
        </div>
        <p v-else class="stempty dim">暂无调度日志（该执行可能早于调度日志功能上线）。</p>
      </section>

      <!-- 步骤手风琴（单开）：触发源 + 各节点 -->
      <section v-if="displaySteps.length" class="card steps-card rise" style="animation-delay:.08s">
        <h3 class="block-title display">执行步骤</h3>
        <div class="steps">
          <div v-for="(s, i) in displaySteps" :key="i" class="stitem" :class="{ open: opened === i, trigger: s.kind === 'trigger' }">
            <div class="sthead" role="button" :aria-expanded="opened === i" :title="stepTimeTip(s)" @click="toggleStep(i)">
              <span v-if="s.kind === 'trigger'" class="stidx mono">源</span>
              <span v-else class="stidx mono">STEP {{ String(i).padStart(2, "0") }}</span>
              <span v-if="s.kind !== 'trigger'" class="stkind mono" :style="{ color: kindAccent(s), borderColor: 'currentColor' }">{{ kindLabel(s) }}</span>
              <div class="stmain">
                <span class="sttitle">{{ stepTitle(s) }}</span>
                <span class="stdesc">{{ stepSub(s) }}</span>
              </div>
              <span v-if="s.started_at" class="sttime mono">{{ fmtShort(s.started_at) }}</span>
              <span v-if="s.kind !== 'trigger'" class="stbadge badge" :class="statusCls(s)" :style="{ '--dot': statusDot(s) }">{{ statusLabel(s) }}</span>
              <svg class="stcaret" :class="{ flip: opened === i }" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
            </div>
            <div v-show="opened === i" class="stbody">
              <!-- 触发源：触发参数 / Webhook 请求体 -->
              <template v-if="s.kind === 'trigger'">
                <span class="stsub mono">触发输入</span>
                <pre v-if="Object.keys(triggerPayload || {}).length" class="log-pre mono">{{ JSON.stringify(triggerPayload, null, 2) }}</pre>
                <p v-else class="stempty dim">本次触发未携带参数。</p>
              </template>

              <!-- Shell：运行配置 + 执行日志 + 输出 -->
              <template v-else-if="effType(s) === 'shell'">
                <span class="stsub mono">运行配置</span>
                <div class="cfg-grid">
                  <span class="cfg-item"><span class="cfg-k">镜像</span><span class="cfg-v mono">{{ s.params?.image || "—" }}</span></span>
                  <span class="cfg-item"><span class="cfg-k">规格</span><span class="cfg-v mono">{{ s.params?.cpu || "?" }} vCPU · {{ s.params?.memory || "?" }} GiB</span></span>
                  <span class="cfg-item"><span class="cfg-k">地域</span><span class="cfg-v mono">{{ s.params?.regionId || "—" }}</span></span>
                  <span class="cfg-item"><span class="cfg-k">载体</span><span class="cfg-v mono">{{ s.params?.credential || "—" }}</span></span>
                  <span class="cfg-item cfg-wide"><span class="cfg-k">命令</span><span class="cfg-v mono">{{ s.params?.command || "（无）" }}</span></span>
                  <span class="cfg-item cfg-wide"><span class="cfg-k">环境变量</span><span class="cfg-v mono">{{ Array.isArray(s.params?.env) && s.params.env.length ? s.params.env.map((e) => `${e.k}=${e.v}`).join("\n") : "（无）" }}</span></span>
                </div>
                <template v-if="s.logs">
                  <span class="stsub mono">执行日志</span>
                  <pre class="log-pre mono">{{ s.logs }}</pre>
                </template>
              </template>

              <!-- 审批：正文 + 接收人 -->
              <template v-else-if="effType(s) === 'approval'">
                <span class="stsub mono">审批内容</span>
                <div class="approval-body" v-html="approvalText(s)"></div>
                <div class="cfg-grid">
                  <span class="cfg-item cfg-wide"><span class="cfg-k">发送给</span><span class="cfg-v mono">{{ approvalTargets(s).join("、") || s.params?.robot || "—" }}</span></span>
                  <span class="cfg-item cfg-wide"><span class="cfg-k">载体凭证</span><span class="cfg-v mono">{{ s.params?.robot || "—" }}</span></span>
                </div>
                <p v-if="!s.logs && !hasOutput(s) && s.status === 'approve'" class="stempty dim">审批卡片已发出，等待审批人处理。</p>
              </template>

              <!-- 通用：日志 / 输出 -->
              <template v-if="s.logs && effType(s) !== 'shell'">
                <span class="stsub mono">执行日志</span>
                <pre class="log-pre mono">{{ s.logs }}</pre>
              </template>
              <template v-if="hasOutput(s)">
                <span class="stsub mono">节点输出</span>
                <pre class="log-pre mono">{{ JSON.stringify(s.output, null, 2) }}</pre>
              </template>
              <p v-if="!s.logs && !hasOutput(s) && s.kind !== 'trigger' && effType(s) !== 'approval'" class="stempty dim">
                该步骤暂无日志（外部等待或未产生输出）。
              </p>
            </div>
          </div>
        </div>
      </section>

      <section v-if="!displaySteps.length" class="card empty rise">
        <p class="dim">该执行暂无步骤与日志输出。</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.title-wrap { display: flex; align-items: flex-end; gap: 14px; }
.head-main { min-width: 0; }
.head-badge { margin-left: 10px; vertical-align: 3px; }

.block-title { margin: 0; font-size: 14px; font-weight: 700; letter-spacing: 0.03em; }
.block-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.steps-card, .log-card { padding: 20px 22px; }
.log-card { margin-bottom: 14px; }

.sched-list { display: flex; flex-direction: column; gap: 6px; max-height: 340px; overflow: auto; }
.sched-row { display: flex; gap: 12px; align-items: baseline; font-size: 12px; line-height: 1.55; }
.sched-ts { color: var(--text-3); flex: none; font-size: 11px; }
.sched-msg { color: var(--text-2); word-break: break-word; }

.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.stitem {
  border: 1px solid var(--line); border-radius: 12px;
  background: var(--bg-1); overflow: hidden;
  transition: border-color .18s ease, box-shadow .18s ease;
}
.stitem.open { border-color: var(--line-strong); box-shadow: 0 0 0 1px var(--line-strong); }
.stitem.trigger .sthead { cursor: default; }
.sthead {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 14px; cursor: pointer; user-select: none;
  transition: background .15s ease;
}
.sthead:hover { background: var(--bg-2); }
.stidx { font-size: 11px; letter-spacing: .05em; color: var(--accent); flex: none; }
.stkind {
  flex: none; font-size: 10.5px; font-weight: 700; letter-spacing: .04em;
  border: 1px solid; border-radius: 999px; padding: 2px 9px;
  background: var(--bg-0);
}
.stmain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sttitle {
  font-size: 13px; font-weight: 600; color: var(--text-1);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.stdesc {
  font-size: 11.5px; color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sttime { flex: none; font-size: 11px; color: var(--text-3); }
.stbadge { flex: none; }
.stcaret { flex: none; color: var(--text-3); transition: transform .18s ease; }
.stcaret.flip { transform: rotate(180deg); }

.stbody { padding: 0 14px 14px; }
.stbody .stsub { display: block; margin: 10px 0 6px; font-size: 11px; color: var(--text-3); letter-spacing: .04em; }
.stbody .stsub:first-child { margin-top: 2px; }
.stempty { margin: 2px 0 0; font-size: 12px; }

.cfg-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; margin-bottom: 4px; }
.cfg-item { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cfg-wide { grid-column: 1 / -1; }
.cfg-k { font-size: 11px; color: var(--text-3); }
.cfg-v { font-size: 12px; color: var(--text-2); white-space: pre-wrap; word-break: break-word; }

.approval-body {
  border: 1px solid var(--line); border-radius: 10px; background: var(--bg-0);
  padding: 12px 14px; font-size: 12.5px; line-height: 1.7; color: var(--text-2);
}
.approval-body :deep(p) { margin: 0 0 8px; }
.approval-body :deep(p:last-child) { margin-bottom: 0; }
.approval-body :deep(h1), .approval-body :deep(h2), .approval-body :deep(h3) { font-size: 15px; margin: 0 0 8px; color: var(--text-1); }
.approval-body :deep(table) { border-collapse: collapse; width: 100%; margin: 6px 0; }
.approval-body :deep(td), .approval-body :deep(th) { border: 1px solid var(--line-strong); padding: 5px 8px; }

.log-pre {
  margin: 0; padding: 14px 16px;
  background: var(--bg-0); border: 1px solid var(--line);
  border-radius: 10px; font-size: 12px; line-height: 1.6;
  color: var(--text-2); overflow-x: auto; white-space: pre-wrap; word-break: break-word;
}
</style>