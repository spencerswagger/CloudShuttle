<!-- 流水线编辑页：路由驱动，新建(/pipelines/new) 或 编辑(/pipelines/:id) -->
<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import { VueFlow, Handle, Position, useVueFlow, MarkerType, BaseEdge, EdgeLabelRenderer, getBezierPath } from "@vue-flow/core";
import "@vue-flow/core/dist/style.css";
import MarkdownIt from "markdown-it";
import { layoutDag, wouldCycle } from "../lib/dagLayout.js";
import { notify } from "../lib/notify.js";
import { buildMappingDraft } from "../lib/webhookDraft.js";
import { getPipeline, createPipeline, updatePipeline, getPipelineHook, resetWebhookSecret, fetchWebhookProbe } from "../api/pipeline.js";
import { fetchImages } from "../api/image.js";
import { fetchCredentials, fetchEciSpecs, probeEciNetworks, listDepartments, listDepartmentUsers } from "../api/credential.js";
import { ECI_REGIONS } from "../lib/kinds.js";
import RunPipelineModal from "../components/RunPipelineModal.vue";
import TriggerParamsEditor from "../components/TriggerParamsEditor.vue";

const route = useRoute();
const router = useRouter();

const images = ref([]);
const creds = ref([]);
const imagesLoading = ref(false);
const credsLoading = ref(false);
const saving = ref(false);

// 下拉数据按需懒加载：仅在需要时请求，并提供刷新
async function loadImages() {
  imagesLoading.value = true;
  try { images.value = await fetchImages().catch(() => []); }
  finally { imagesLoading.value = false; }
}
async function loadCreds() {
  credsLoading.value = true;
  try { creds.value = await fetchCredentials().catch(() => []); }
  finally { credsLoading.value = false; }
}

const triggerNodeId = "t1";
const newPipeline = () => ({
  id: null, name: "未命名流水线", description: "",
  spec_json: {
    nodes: [{ id: triggerNodeId, type: "trigger", kind: "manual", params: {}, name: "触发源", position: { x: 60, y: 60 } }],
    edges: [],
    trigger: { params: [] },
  },
});
const current = ref(newPipeline());
const nodes = computed(() => current.value.spec_json.nodes);

// ---------- DAG 自由画布：spec.nodes / spec.edges 是唯一数据源，VueFlow 视图由它们派生 ----------
const { fitView, screenToFlowCoordinate } = useVueFlow();
const spec = computed(() => current.value.spec_json);
// 右侧配置面板选中节点（画布点击驱动；会话态，不入库）
const selectedId = ref("");
const selected = computed(() => nodes.value.find((x) => x.id === selectedId.value) ?? null);
function selectNode(id) { selectedId.value = id; }
// 边选中态：点选边进入边条件配置（与节点选中互斥：选择边时收起节点浮窗）
const selEdgeId = ref("");
const selEdge = computed(() => spec.value.edges.find((e) => edgeIdOf(e) === selEdgeId.value) ?? null);
function selectEdge(id) { selEdgeId.value = id; }
// 边条件编辑：直接改 spec.edges 中对应边的 cond 字段（null 表示无条件边）
function setEdgeCond(e, patch) { e.cond = { ...(e.cond ?? {}), ...patch }; }

// 节点没有 position（老数据）时的兜底排布；新节点用 defaultNodePosition 级联放置
function ensurePositions() {
  nodes.value.forEach((n, i) => {
    if (!n.position || !Number.isFinite(n.position?.x) || !Number.isFinite(n.position?.y)) {
      n.position = { x: 60 + (i % 4) * 250, y: 60 + Math.floor(i / 4) * 130 };
    }
  });
}
function defaultNodePosition() {
  const n = nodes.value.length;
  return { x: 60 + (n % 4) * 250, y: 60 + Math.floor(n / 4) * 130 };
}

// spec → VueFlow 元素（edges 由后端 {from,to} 转 vf {id,source,target}；渲染完成即按拖拽/布局写回 spec）
const vfNodes = computed(() => nodes.value.map((n, i) => ({
  id: n.id,
  type: "dag-node", // 统一节点类型，卡片由 #node-dag-node 单槽渲染（配色取 NODE_KINDS）
  position: n.position ?? { x: 60 + (i % 4) * 250, y: 60 + Math.floor(i / 4) * 130 },
  data: { n },
})));
const edgeIdOf = (e) => `e${e.from}>${e.to}`;
const vfEdges = computed(() => (spec.value.edges ?? []).map((e) => ({
  id: edgeIdOf(e),
  source: e.from,
  target: e.to,
  type: "default",
  data: { from: e.from, to: e.to, cond: e.cond },
  markerEnd: { type: MarkerType.ArrowClosed, color: "#54d0c6" },
  style: { stroke: "var(--line-strong)", strokeWidth: 1.6 },
})));

// 画布事件：拖动/删除节点 → 写回 spec；删边 → 写回 spec.edges；新建边 → 判环后 push
function onNodesChange(changes) {
  for (const ch of changes) {
    if (ch.type === "position" && ch.position) {
      const n = nodes.value.find((x) => x.id === ch.id);
      if (!n) continue;
      const cur = n.position;
      if (!cur || cur.x !== ch.position.x || cur.y !== ch.position.y) n.position = { x: ch.position.x, y: ch.position.y };
    } else if (ch.type === "remove") {
      removeNodeById(ch.id);
    }
  }
}
function onEdgesChange(changes) {
  for (const ch of changes) {
    if (ch.type !== "remove") continue;
    const i = vfEdges.value.findIndex((e) => e.id === ch.id);
    if (i >= 0) spec.value.edges.splice(i, 1);
  }
}
function onConnect(conn) {
  const { source, target } = conn;
  if (!source || !target || source === target) {
    notify({ type: "error", message: "不能把节点连接到自己" });
    return;
  }
  if (target === triggerNodeId) {
    notify({ type: "error", message: "触发源是起点，只能作为出边，不能连入" });
    return;
  }
  const edges = spec.value.edges;
  if (edges.some((e) => e.from === source && e.to === target)) {
    notify({ type: "error", message: "两点之间已存在连线" });
    return;
  }
  if (wouldCycle(edges, source, target)) {
    notify({ type: "error", message: "该连线会形成环，已取消连接" });
    return;
  }
  edges.push({ from: source, to: target });
}
// 删除节点：同步清掉关联边；若正在编辑该节点则收起右侧面板
function removeNodeById(id) {
  if (id === triggerNodeId || isTrigger(nodes.value.find((x) => x.id === id))) return;
  const i = nodes.value.findIndex((x) => x.id === id);
  if (i < 0) return;
  nodes.value.splice(i, 1);
  const edges = spec.value.edges;
  for (let j = edges.length - 1; j >= 0; j--) {
    if (edges[j].from === id || edges[j].to === id) edges.splice(j, 1);
  }
  if (selectedId.value === id) selectedId.value = "";
}
function removeEdgeByData({ from, to }) {
  const i = spec.value.edges.findIndex((e) => e.from === from && e.to === to);
  if (i >= 0) spec.value.edges.splice(i, 1);
}
function onNodeClick({ event, node }) {
  if (event.target?.closest?.(".vue-flow__handle")) return; // 拖手柄连线时不弹出面板
  selectNode(node.id);
  selEdgeId.value = ""; // 选中节点时收起边配置
}
function onPaneClick() { selectedId.value = ""; selEdgeId.value = ""; }
function onEdgeClick({ edge }) {
  selectedId.value = ""; // 选边时收起节点浮窗
  selEdgeId.value = edge.id;
}

// 边的悬停删除键：hover 边时显示（移入按钮有小延迟，保证能点到）
const hoverEdgeId = ref("");
let hideEdgeTimer = null;
function onEdgeMouseEnter({ edge }) { clearTimeout(hideEdgeTimer); hoverEdgeId.value = edge.id; }
function onEdgeMouseLeave({ edge }) {
  clearTimeout(hideEdgeTimer);
  hideEdgeTimer = setTimeout(() => { if (hoverEdgeId.value === edge.id) hoverEdgeId.value = ""; }, 240);
}
function onEdgeDelMouseEnter(id) { clearTimeout(hideEdgeTimer); hoverEdgeId.value = id; }

function edgePath(ep) {
  const [path] = getBezierPath({
    sourceX: ep.sourceX, sourceY: ep.sourceY, sourcePosition: ep.sourcePosition,
    targetX: ep.targetX, targetY: ep.targetY, targetPosition: ep.targetPosition,
  });
  return path;
}
function edgeDelStyle(ep) {
  const [, x, y] = getBezierPath({
    sourceX: ep.sourceX, sourceY: ep.sourceY, sourcePosition: ep.sourcePosition,
    targetX: ep.targetX, targetY: ep.targetY, targetPosition: ep.targetPosition,
  });
  return { left: x + "px", top: y + "px", transform: "translate(-50%, -50%)" };
}

// 自动布局：layoutDag 算坐标写回各 node.position，再 fitView
function autoLayout() {
  const ns = nodes.value;
  if (!ns.length) { notify({ type: "info", message: "画布为空，请先添加节点" }); return; }
  const laid = layoutDag(ns, spec.value.edges, { w: 200, h: 60, gapX: 48, gapY: 96 });
  const x0 = Math.min(...laid.map((p) => p.x));
  const y0 = Math.min(...laid.map((p) => p.y));
  const byId = Object.fromEntries(laid.map((p) => [p.id, p]));
  for (const n of ns) {
    const p = byId[n.id];
    if (p) n.position = { x: p.x - x0 + 40, y: p.y - y0 + 40 };
  }
  nextTick(() => { fitView({ padding: 0.25, duration: 250 }).catch(() => {}); });
  notify({ type: "success", message: "已按依赖关系自动布局" });
}

// 节点库卡片：点击即添加；拖入画布可指定落点（HTML5 DnD，落点经 viewport 换算成画布坐标）
function onLibDragStart(ev, type) {
  ev.dataTransfer?.setData("application/x-cloudshuttle-node", type);
  ev.dataTransfer.effectAllowed = "copy";
}
function onCanvasDragOver(ev) { ev.preventDefault(); }
function onCanvasDrop(ev) {
  const type = ev.dataTransfer?.getData("application/x-cloudshuttle-node");
  if (!type || !NODE_KINDS[type]) return;
  ev.preventDefault();
  let at = null;
  try { at = screenToFlowCoordinate({ x: ev.clientX, y: ev.clientY }); } catch { /* 未就绪时回落级联位置 */ }
  addNode(type, at);
}

// 由路由参数判定是否编辑态：新建/编辑不再依赖返显是否成功
const editingId = computed(() => (route.params.id ? +route.params.id : null));
const isNew = computed(() => !editingId.value);
// 顶部栏名称内联编辑（会话态）
const nameEditing = ref(false);
const nameDraft = ref("");
const nameInputEl = "pipeline-name-input";
function startNameEdit() {
  nameDraft.value = current.value.name;
  nameEditing.value = true;
  nextTick(() => { const el = document.getElementById(nameInputEl); el?.focus(); el?.select(); });
}
function commitName() {
  if (!nameEditing.value) return;
  const v = String(nameDraft.value ?? "").trim();
  if (!v) { notify({ type: "error", message: "流水线名称不能为空" }); nameDraft.value = current.value.name; nameEditing.value = false; return; }
  current.value.name = v;
  nameEditing.value = false;
}
function cancelName() { nameEditing.value = false; }

async function hydrate() {
  // 新建保存后 router.replace 落到真实 id 会再次触发本 watcher：内存数据已是最新且刚持久化，直接跳过重载
  // （避免关闭参数浮窗、清空 Webhook 会话）
  if (current.value.id && current.value.id === editingId.value) return;
  if (!editingId.value) { current.value = newPipeline(); resetHookSession(); return; }
  try {
    const p = await getPipeline(editingId.value);
    current.value = JSON.parse(JSON.stringify(p));
    resetHookSession(); // 切换流水线：丢弃后端下发的触发地址与调试接收态，避免跨 /pipelines/:id 残留
    selectedId.value = ""; // 收起画布右侧配置面板
    if (!current.value.spec_json?.edges) current.value.spec_json.edges = [];
    // 触发源画布化：旧数据 nodes 无 trigger 节点时注入一个（kind 取顶层 trigger.kind，缺省 manual）
    if (!current.value.spec_json.nodes.some((n) => isTrigger(n))) {
      current.value.spec_json.nodes.unshift({
        id: triggerNodeId, type: "trigger",
        kind: current.value.spec_json.trigger?.kind ?? "manual",
        params: {}, name: "触发源", position: defaultNodePosition(),
      });
    }
    const trg = current.value.spec_json.nodes.find((n) => isTrigger(n));
    if (trg) triggerTab.value = trg.kind === "webhook" ? "webhook" : "manual";
    ensurePositions(); // 老数据节点补 position，保证画布可拖
    // 下拉数据懒加载：仅当节点实际用到镜像/凭证才请求，避免挂载即连拉 3 个接口
    const ns = current.value.spec_json?.nodes ?? [];
    if (ns.some((n) => n.type === "shell" || n.type === "approval" || n.type === "sql")) loadCreds();
    if (ns.some((n) => n.type === "shell")) loadImages();
    nextTick(() => { fitAll(); fitView({ padding: 0.2, duration: 0 }).catch(() => {}); }); // 回填后重算输入框高度，并缩放画布到全部节点
  } catch (e) {
    if (e?.status === 404) notify({ type: "error", message: "未找到该流水线，可能已被删除" });
    else notify({ type: "error", message: e?.message || "加载流水线失败" });
  }
}
watch(() => route.params.id, hydrate);
onMounted(hydrate);

// ---------- 可用变量：本地按静态作用域计算（触发参数 ∪ 前驱 outputs ∪ 内置），与后端 checkVars 同规则 ----------
const VAR_MEANINGS = {
  pipeline_name: "流水线名称", run_no: "执行编号", started_at: "发起时间",
  pipeline_id: "流水线 ID", exec_id: "执行 ID",
};
// 节点可用变量明细分组（供「插入变量」面板展示）：每组 items=[{k,t,d}]，k 变量名、t 标题、d 说明
function varGroups(n) {
  const spec = current.value?.spec_json || {};
  const groups = [];
  const used = new Set();
  const trig = [];
  // 统一触发参数（triggerCfg 已把旧结构归一）：标题/说明/默认值直接取自配置
  for (const p of triggerParams.value ?? []) {
    if (!p?.key || used.has(p.key)) continue;
    used.add(p.key);
    const sub = [];
    if (p.default != null && p.default !== "") sub.push("默认 " + p.default);
    if (p.description) sub.push(p.description);
    if (p.jsonPath) sub.push("Webhook: " + p.jsonPath);
    trig.push({ k: p.key, t: p.title || p.key, d: sub.join(" · ") });
  }
  if (trig.length) groups.push({ g: "触发参数", items: trig });
  // 上游节点声明的 outputs（沿 edges 反向闭包）
  const parentsOf = {};
  for (const e of spec.edges ?? []) (parentsOf[e.to] ??= []).push(e.from);
  const byId = Object.fromEntries((spec.nodes ?? []).map((x) => [x.id, x]));
  const up = [];
  const stack = [...(parentsOf[n?.id] ?? [])];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const o of byId[id]?.params?.outputs ?? []) {
      if (o?.key && !used.has(o.key)) {
        used.add(o.key);
        const sel = o.description || o.title;
        up.push({
          k: o.key,
          t: o.title || o.key,
          d: [sel ? `来自节点 ${drainId(id)} · ${sel}` : `来自节点 ${drainId(id)}`, o.type].filter(Boolean).join(" · "),
        });
      }
    }
    stack.push(...(parentsOf[id] ?? []));
  }
  if (up.length) groups.push({ g: "上游节点输出", items: up });
  const builtin = Object.entries(VAR_MEANINGS)
    .filter(([k]) => !used.has(k))
    .map(([k, label]) => ({ k, t: label, d: "运行时自动注入" }));
  groups.push({ g: "执行内置", items: builtin });
  return groups;
}
// 「插入变量」下拉面板：同一时刻只开一个，key = nodeId:field
const varDrop = ref("");
function toggleVarDrop(key) { varDrop.value = varDrop.value === key ? "" : key; }
// 插入：优先在当前聚焦字段的光标处插入，否则追加到字段末尾；直接写响应式参数，无需模拟 input 事件
const activeField = ref(null); // { el, node, field }
function onFieldFocus(ev, n, field) { activeField.value = { el: ev.target, node: n, field }; }
// 读取/写入字段值：支持 "env:0:v" 这类嵌套路径字段（分隔方式与 env 行 field key 一致）
function paramGet(p, field) {
  if (typeof field !== "string" || !field.includes(":")) return p ? p[field] : undefined;
  return field.split(":").reduce((o, k) => (o == null ? o : o[k]), p);
}
function paramSet(p, field, v) {
  if (typeof field !== "string" || !field.includes(":")) { if (p) p[field] = v; return; }
  const segs = field.split(":");
  let o = p;
  for (let i = 0; i < segs.length - 1; i++) { if (o == null) return; o = o[segs[i]]; }
  if (o) o[segs[segs.length - 1]] = v;
}
function insertVar(name, n, field) {
  const snippet = "${" + name + "}";
  const p = n?.params;
  if (!p) return;
  varDrop.value = "";
  const cur = String(paramGet(p, field) ?? "");
  const af = activeField.value;
  if (af && af.node === n && af.field === field && document.contains(af.el)) {
    const el = af.el;
    const s = el.selectionStart ?? cur.length;
    const e = el.selectionEnd ?? cur.length;
    paramSet(p, field, cur.slice(0, s) + snippet + cur.slice(e));
    nextTick(() => { el.focus(); const pos = s + snippet.length; el.setSelectionRange(pos, pos); if (el.classList?.contains?.("autofit")) fit(el); });
  } else {
    // 嵌套字段多为单行 input，不追加换行；顶层 textarea 保持原有换行补全
    paramSet(p, field, field.includes(":") ? cur + snippet : (cur && !cur.endsWith("\n") ? cur + "\n" + snippet : cur + snippet));
    nextTick(fitAll);
  }
}
// textarea 高度自适应：CSS field-sizing 优先，此处兜底旧内核
function fit(el) { if (!el) return; el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; }
function autofit(ev) { fit(ev.target); }
function fitAll() { document.querySelectorAll("textarea.autofit").forEach(fit); }

const COND_OPS = ["eq", "ne", "gt", "ge", "lt", "le", "contains", "starts_with", "ends_with", "exists", "empty", "regex"];
const COND_OP_LABELS = { eq: "等于", ne: "不等于", gt: "大于", ge: "大于等于", lt: "小于", le: "小于等于", contains: "包含", starts_with: "以…开头", ends_with: "以…结尾", exists: "存在", empty: "为空", regex: "正则匹配" };
const NODE_KINDS = {
  trigger:  { label: "触发源",   accent: "var(--warn)", icon: "M5 3h14v18l-7-4-7 4z" },
  shell:    { label: "Shell 执行",   accent: "var(--accent)",  icon: "M4 5l6 7-6 7m8 0h8" },
  approval: { label: "人工审批",     accent: "var(--ember)",   icon: "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6zm-3.5 6.5L11 12l4-4.5" },
  sql:      { label: "SQL 执行",     accent: "var(--accent)",  icon: "M4 5h16M7 3l2 2-2 2M12 3l2 2-2 2M7 12H4v3h3zM4 21h7M6 15v6M15 8l5 5M15 13h2a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2h-2" },
  branch:  { label: "条件分支", accent: "var(--warn)",   icon: "M7 3v7a2 2 0 0 0 2 2h2m-4 9v-5m0 0h-3m3 0h3m4-9l5-5m0 0V3h-5m5 0v5" },
  join:    { label: "汇聚",     accent: "var(--accent)", icon: "M4 4h16M8 8h8M12 12v8M4 20h16" },
  loop:    { label: "循环",     accent: "var(--ember)",  icon: "M17 2l4 4-4 4m4-4H8a6 6 0 0 0-6 6v1m5 5l-4 4 4 4m-4-4h8a6 6 0 0 0 6-6v-1" },
};
const LIB_TYPES = ["shell", "approval", "sql", "branch", "join", "loop"];
const isTrigger = (n) => n?.type === "trigger";

// 悬浮参数浮窗拖拽状态 + 画布「回到原位」
const floatPos = ref({ right: "24px", top: "80px" });
let floatDrag = null;
function startFloatDrag(e) {
  floatDrag = { dx: e.clientX, dy: e.clientY, right: floatPos.value.right, top: floatPos.value.top };
  window.addEventListener("mousemove", onFloatDrag);
  window.addEventListener("mouseup", stopFloatDrag);
}
function onFloatDrag(e) {
  if (!floatDrag) return;
  const right = Math.max(8, parseFloat(floatDrag.right) + (floatDrag.dx - e.clientX));
  const top = Math.max(8, parseFloat(floatDrag.top) + (e.clientY - floatDrag.dy));
  floatPos.value = { right: right + "px", top: top + "px" };
}
function stopFloatDrag() {
  floatDrag = null;
  window.removeEventListener("mousemove", onFloatDrag);
  window.removeEventListener("mouseup", stopFloatDrag);
}
onBeforeUnmount(() => stopFloatDrag());
const fitAllNodes = () => { nextTick(() => { fitView({ padding: 0.2, duration: 250 }).catch(() => {}); }); };
// Shell 节点运行规格：阿里云按「CPU → 内存」定义规格组合（核内比 1:1 ~ 1:8）。
// 预设档位在未选中凭证/接口探测失败时兜底；选中凭证+地域后探测量接口返回真实可购组合与目录价。
const ECI_PRESET_BY_CPU = {
  0.5: [1, 2],
  1: [1, 2, 4, 8],
  2: [2, 4, 8, 16],
  4: [4, 8, 16, 32],
  8: [8, 16, 32, 64],
};
const specByCpu = ref(null); // { cpu: [{ memory, price: {originalPrice, tradePrice, currency}|null }] }
const eciSpecLoading = ref(false);
const eciSpecError = ref("");
const cpuChoices = computed(() => {
  const keys = specByCpu.value ? Object.keys(specByCpu.value) : Object.keys(ECI_PRESET_BY_CPU);
  return keys.length ? keys : [1];
});
function memChoicesOf(cpu) {
  const list = specByCpu.value?.[cpu] ?? null;
  if (Array.isArray(list)) return list; // [{memory, price}]
  return (ECI_PRESET_BY_CPU[cpu] || []).map((m) => ({ memory: m, price: null }));
}
function priceSuffix(choice) {
  const p = choice?.price?.originalPrice;
  return typeof p === "number" ? `（目录 ¥${p}/时）` : "";
}
// CPU 切换后把内存修正为该 CPU 支持档位的最小值（当前值不在新档位列表时）
function normMemFor(n) {
  const mems = memChoicesOf(n.params.cpu).map((mc) => String(mc.memory));
  if (!mems.includes(String(n.params.memory))) n.params.memory = mems[0] ?? "";
}
// 用 eci 凭证 + Shell 节点地域探测可购规格：成功刷新 byCpu，失败降级预设并提示原因
function probeEciSpecs(name, regionId) {
  if (!name || !regionId) return;
  eciSpecLoading.value = true;
  eciSpecError.value = "";
  fetchEciSpecs(name, regionId)
    .then((res) => {
      const d = res?.data ?? res;
      if (d?.ok === false || !d?.byCpu) throw new Error(d?.message || "无法获取 ECI 规格");
      specByCpu.value = d.byCpu;
    })
    .catch((err) => {
      specByCpu.value = null;
      eciSpecError.value = err?.message || String(err);
    })
    .finally(() => { eciSpecLoading.value = false; });
}

// Shell 节点网络探测：选凭证+地域后，用服务端解密的 AK 查该地域交换机/安全组，供输入框 datalist 候选
const netProbing = ref(false);
const netError = ref("");
const netSearched = ref(false);
const netVswitches = ref([]);
const netSecurityGroups = ref([]);
function probeNodeNetworks(name, regionId) {
  if (!name || !regionId) return;
  netProbing.value = true;
  netError.value = "";
  probeEciNetworks({ credential: name, regionId })
    .then((res) => {
      const d = res?.data ?? res;
      if (d?.ok === false) throw new Error(d?.message || "探测失败");
      netVswitches.value = d?.vswitches ?? [];
      netSecurityGroups.value = d?.securityGroups ?? [];
      netSearched.value = true;
    })
    .catch((err) => {
      netError.value = err?.message || String(err);
      netVswitches.value = [];
      netSecurityGroups.value = [];
    })
    .finally(() => { netProbing.value = false; });
}
const nodeCreateVswitchUrl = () => {
  const r = currentShellRegion();
  return r ? `https://vpc.console.aliyun.com/vpc/${encodeURIComponent(r)}/vswitches` : "https://vpc.console.aliyun.com";
};
const nodeCreateSecurityGroupUrl = () => {
  const r = currentShellRegion();
  return r
    ? `https://ecs.console.aliyun.com/securityGroup/region/${encodeURIComponent(r)}/securityGroups`
    : "https://ecs.console.aliyun.com";
};
function currentShellRegion() {
  for (const n of nodes.value) {
    if (n.type === "shell" && n.params?.regionId) {
      const r = String(n.params.regionId).trim();
      if (r) return r;
    }
  }
  return "";
}
// 任一 shell 节点的「凭证 + 地域」组合变化时，自动探测规格与网络（含首次加载已配置的节点）
let prevEciKey = {};
watch(
  () => nodes.value.filter((n) => n.type === "shell").map((n) => ({
    id: n.id, c: n.params?.credential ?? "", r: n.params?.regionId ?? "",
  })),
  (list) => {
    const cur = {};
    for (const { id, c, r } of list) {
      const key = `${c}|${r}`;
      cur[id] = key;
      if (c && r && key !== prevEciKey[id]) {
        probeEciSpecs(c, r);
        probeNodeNetworks(c, r);
      }
    }
    prevEciKey = cur;
  }
);

const drainId = (id) => {
  const s = String(id);
  const m = s.match(/n(\d+)/);
  return m ? "#" + m[1].slice(-4) : s;
};

const convKinds = ["dingtalk-corp"];
const isCorpRobot = (name) => {
  const c = creds.value.find((x) => x.name === name);
  return convKinds.includes(c?.kind);
};
// shell 节点只展示 eci 类型凭证作为运行载体
const eciCreds = computed(() => (creds.value || []).filter((c) => c.kind === "eci"));
// 审批节点只展示支持审批的凭证类型（钉钉企业机器人；未来可扩展其他审批渠道）
const APPROVAL_CRED_KINDS = ["dingtalk-corp"];
const robotCreds = computed(() => (creds.value || []).filter((c) => APPROVAL_CRED_KINDS.includes(c.kind)));
// sql 节点只展示 mysql / pg 类型凭证作为连接目标（secret 后端不回显，前端仅做下拉过滤）
const SQL_CRED_KINDS = ["mysql", "pg"];
const sqlCreds = computed(() => (creds.value || []).filter((c) => SQL_CRED_KINDS.includes(c.kind)));

// 高级机器人下拉：主标题取自凭证名，副标题拼接企业/应用元信息（display_meta），并展示应用图标
const robotOpenId = ref(""); // 当前展开下拉的节点 id；空串表示全部收起
const kindName = (k) => ({ "dingtalk-corp": "钉钉企业机器人", eci: "阿里云 ECI", git: "Git 令牌" }[k] || k || "凭证");
const credTitle = (c) => c?.name || "未命名凭证";
const credSub = (c) => {
  const parts = [];
  if (c?.display_meta?.corpName) parts.push(c.display_meta.corpName);
  if (c?.display_meta?.appName) parts.push(c.display_meta.appName);
  if (!parts.length) parts.push(kindName(c?.kind));
  return parts.join(" · ");
};
const KIND_BADGE = { "dingtalk-corp": "钉", git: "G" };
const selectedCred = (n) => creds.value.find((x) => x.name === n.params.robot);
function toggleRobotDrop(id) { robotOpenId.value = robotOpenId.value === id ? "" : id; }
function pickRobot(n, name) { n.params.robot = name; robotOpenId.value = ""; }
function onDocClick() { if (robotOpenId.value) robotOpenId.value = ""; if (varDrop.value) varDrop.value = ""; }
onMounted(() => document.addEventListener("click", onDocClick));

// 审批卡片正文定制：内置占位符按流水线/执行运行时填充，前端默认给出带占位符的完整模板，避免空正文
// 注意：占位符 ${...} 必须放普通字符串；写进反引号模板串会被 JS 当插值导致 ReferenceError
const DEFAULT_APPROVAL_BODY =
  "### 人工审批请求\n\n" +
  "| 项 | 内容 |\n|---|---|\n" +
  "| 流水线 | ${pipeline_name} |\n" +
  "| 执行编号 | #${run_no} |\n" +
  "| 发起时间 | ${started_at} |\n\n" +
  "请审核该审批请求，确认无误后点击下方按钮通过。";
// 从 shell 命令中探测写回 CLOUDSHUTTLE_OUT_FILE 的 echo 输出 key，合并进输出变量列表
function probeOutputKeysFromCommand(command) {
  const keys = new Set();
  const lines = String(command ?? "").split("\n");
  for (const line of lines) {
    if (!line.includes("CLOUDSHUTTLE_OUT_FILE")) continue;
    const m = line.match(/echo\s+["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*=/);
    if (m) keys.add(m[1]);
  }
  return [...keys];
}
function autoProbeOutputs(n) {
  const keys = probeOutputKeysFromCommand(n.params?.command);
  if (!keys.length) {
    notify({ type: "info", message: "命令中未识别到写入 $CLOUDSHUTTLE_OUT_FILE 的 echo \"key=value\" 输出" });
    return;
  }
  const outputs = n.params.outputs ?? (n.params.outputs = []);
  const existing = new Set(outputs.map((o) => o?.key).filter(Boolean));
  let added = 0;
  for (const k of keys) {
    if (!existing.has(k)) {
      outputs.push({ key: k, title: "", type: "string", default: "", required: false, description: "", options: [] });
      added++;
    }
  }
  notify({ type: "success", message: added ? `已从命令提取 ${added} 个输出变量` : "命令中涉及的输出变量均已存在" });
}
const resetApprovalMsg = (n) => { n.params.message = DEFAULT_APPROVAL_BODY; nextTick(fitAll); };
const approvalPreview = (n) => {
  const vars = {
    pipeline_name: "release-构建-发布", run_no: "12",
    started_at: "2026-08-29 10:00:00", exec_id: "34", pipeline_id: "5",
  };
  const body = n.params.message || DEFAULT_APPROVAL_BODY;
  return String(body).replace(/\$\{([A-Za-z][\w]*)\}/g, (m, k) => (k in vars ? vars[k] : m));
};
// 卡片正文以占位符填充后的样例 Markdown 渲染预览，与输入框切换显示
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const cardModes = reactive({}); // nodeId -> "edit" | "preview"，仅前端 UI 态，不入库
const cardModeOf = (n) => cardModes[n.id] ?? "edit";
const approvalHtml = (n) => {
  try { return md.render(approvalPreview(n)); } catch { return approvalPreview(n); }
};

// 通讯录选择器：按部门树逐层加载，勾选成员填回 target.members（含部门层级），并同步 openIds 供后端使用
const orgOpen = ref(false);
const orgLoading = ref(false);
const orgCred = ref("");
const orgNode = ref(null);
const orgPath = ref([]);
const orgDepts = ref([]);
const orgUsers = ref([]);
const orgSel = reactive(new Map()); // userId -> { name, dept }

async function orgLoad() {
  orgLoading.value = true;
  try {
    const cur = orgPath.value.length ? orgPath.value[orgPath.value.length - 1] : null;
    const deptId = cur ? cur.id : 1;
    const [d, u] = await Promise.all([
      listDepartments(orgCred.value, deptId),
      listDepartmentUsers(orgCred.value, deptId),
    ]);
    orgDepts.value = d.departments ?? [];
    orgUsers.value = u.users ?? [];
  } catch { /* 全局拦截器提示 */ }
  finally { orgLoading.value = false; }
}
function openOrg(node) {
  if (!node.params.robot) { notify({ type: "error", message: "请先选择钉钉企业机器人" }); return; }
  orgCred.value = node.params.robot;
  orgNode.value = node;
  orgPath.value = [];
  orgSel.clear();
  // 回显已有成员到选择器，便于增删
  for (const m of nodeTarget(node).members ?? []) orgSel.set(m.userId, { name: m.name, dept: m.dept });
  orgOpen.value = true;
  orgLoad();
}
function orgGoto(d) { orgPath.value.push({ id: d.id, name: d.name }); orgLoad(); }
function orgGotoIndex(i) { orgPath.value.splice(i); orgLoad(); }
function orgToggle(u) {
  const dept = orgPath.value.map((p) => p.name).join(" / ");
  orgSel.has(u.userId) ? orgSel.delete(u.userId) : orgSel.set(u.userId, { name: u.name, dept });
}
function orgConfirm() {
  const node = orgNode.value;
  if (!orgSel.size) { notify({ type: "error", message: "未选择成员" }); return; }
  const members = [...orgSel.entries()].map(([userId, v]) => ({ userId, name: v.name, dept: v.dept }));
  nodeTarget(node).members = members;
  nodeTarget(node).openIds = members.map((m) => m.userId).join(",");
  nodeTarget(node).openNames = members.map((m) => m.name).join("、");
  nodeTarget(node).type = "user";
  nodeTarget(node).openConversationId = "";
  orgOpen.value = false;
  notify({ type: "success", message: `已选 ${members.length} 人：${members.map((m) => m.name).join("、")}` });
}

// 成员回显：优先 target.members（含部门层级）；老数据仅存 openNames 时退化为多行纯姓名（不可单独删除）
const displayMembers = (n) => {
  const t = nodeTarget(n);
  if (Array.isArray(t.members) && t.members.length) return t.members;
  return (t.openNames || "").split(/[、,]/).filter(Boolean).map((name) => ({ name, dept: "", userId: "" }));
};
function removeMember(n, i) {
  const t = nodeTarget(n);
  if (!Array.isArray(t.members)) return; // 老数据无 members，不可单独删
  t.members.splice(i, 1);
  t.openIds = t.members.map((m) => m.userId).join(",");
  t.openNames = t.members.map((m) => m.name).join("、");
}

// 保证旧节点也有 target 配置对象（审批节点仅发人）
const nodeTarget = (n) =>
  n.params.target ?? (n.params.target = { type: "user", openConversationId: "", openIds: "", members: [] });

// 添加节点：at 指定画布落点（拖入），否则级联排布；新节点自动选中进入右侧配置面板
const addNode = (type, at) => {
  // 添加节点后会用到对应下拉，此时再按需加载其数据
  if (type === "shell" || type === "approval" || type === "sql") loadCreds();
  if (type === "shell") loadImages();
  const node = {
    id: `n${Date.now()}`,
    type,
    step: type,
    params:
        type === "shell"
          ? { image: images.value[0]?.image ?? "alpine", command: "", env: [], outputs: [{ key: "step_out" }], credential: "", regionId: "", vswitchId: "", securityGroupId: "", cpu: "1", memory: "2", timeout: 300 }
          : type === "sql"
            ? { credential: "", statements: [""], outputs: [{ key: "affected_rows" }], timeout: 60 }
            : type === "loop"
              ? { items: { count: 3 }, accumulate: [] }
              : type === "branch" || type === "join"
                ? {}
                : { robot: "", message: DEFAULT_APPROVAL_BODY, target: { type: "user", openIds: "", members: [] } },
    name: "",
    position: at ?? defaultNodePosition(),
  };
  current.value.spec_json.nodes.push(node);
  selectedId.value = node.id; // 新节点选中即编辑
  nextTick(() => { fitView({ padding: 0.3, duration: 300 }).catch(() => {}); });
};

// loop 表单辅助：迭代来源切换与循环体节点列表（前端只读计算，不校验——校验由后端保存/运行期负责）
function loopItemsModeOf(n) {
  n.params.items ?? (n.params.items = { count: 3 }); // 旧数据/手造数据兜底，防渲染读 undefined 崩溃
  return n.params.items.path ? "path" : "count";
}
function addAccumulate(n) {
  n.params.accumulate ?? (n.params.accumulate = []); // 兜底，防「＋添加累积」对缺失数组 push 崩溃
  n.params.accumulate.push({ key: "", from: "", field: "" });
}
function setLoopItemsMode(n, mode) {
  n.params.items = mode === "count" ? { count: n.params.items?.count ?? 3 } : { path: n.params.items?.path ?? "$.trigger.items" };
}
function loopBody(n) {
  const byId = new Map(nodes.value.map((x) => [x.id, x]));
  const edges = spec.value.edges ?? [];
  const succ = {};
  for (const x of nodes.value) { succ[x.id] = []; }
  for (const e of edges) { succ[e.from].push(e.to); }
  const seen = new Set(); const joins = [];
  const stack = [...(succ[n.id] ?? [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    if (byId.get(id)?.type === "join") { joins.push(id); continue; }
    for (const c of succ[id] ?? []) stack.push(c);
  }
  if (joins.length !== 1) return [];
  return [...seen].filter((id) => id !== joins[0]).map((id) => byId.get(id)).filter(Boolean);
}

const save = async ({ stay = false } = {}) => {
  if (!current.value.name.trim()) { notify({ type: "error", message: "请先填写流水线名称" }); return false; }
  // 编辑态下若返显失败（id 缺失）则不静默新建、也不空覆盖，提示重试
  if (editingId.value && !current.value.id) {
    notify({ type: "error", message: "流水线数据尚未加载完成，请稍候或刷新后重试" });
    return false;
  }
  saving.value = true;
  try {
    if (editingId.value) await updatePipeline(editingId.value, current.value);
    else Object.assign(current.value, await createPipeline(current.value));
    notify({ type: "success", message: "已保存流水线 ✓" });
    hookAutoFor = null; // 名称/spec 可能变化，保存后允许重新拉取触发地址
    if (stay) {
      if (isNew.value) router.replace(`/pipelines/${current.value.id}`); // 新建 stay 模式：URL 落到真实 id，防刷新丢失
      else if (triggerTab.value === "webhook") loadHook({ quiet: true }); // 留在页面时刷新地址
    } else {
      router.push("/pipelines");
    }
    return true;
  } catch { /* 全局拦截器提示 */ return false; }
  finally { saving.value = false; }
};

// 需要 id 的操作（获取触发地址、调试接收）在未保存时先自动保存且不离开页面
async function ensureSaved() {
  if (current.value.id) return true;
  if (triggerTab.value === "webhook") notify({ type: "success", message: "首次获取地址将先保存当前流水线" });
  return await save({ stay: true });
}

const runModal = ref(null);
const run = () => {
  if (!current.value.id) { notify({ type: "error", message: "请先保存流水线再运行" }); return; }
  runModal.value.open(current.value);
};

const back = () => router.push("/pipelines");

// ---------- T13 触发源配置 ----------
// 统一触发参数：manual 与 webhook 共用一份 params（key/title/type/default/required/description 齐全，
// webhook 触发额外用每项 jsonPath 从请求体取值）。旧数据（manual.params + webhook.mappings 分离）
// 在 triggerCfg 归一时按 key 合并为新结构，保存后落库即为统一形态。
// 把旧结构 manual.params + webhook.mappings 合并为统一 params（与后端 triggerParamsOf 同规则）
function mergeLegacyTrigger(t) {
  const merged = new Map();
  for (const p of t?.manual?.params ?? []) if (p?.key) merged.set(p.key, { ...p, options: p.options ?? [] });
  for (const m of t?.webhook?.mappings ?? []) {
    if (!m?.name) continue;
    const hit = merged.get(m.name);
    if (hit) hit.jsonPath = m.jsonPath;
    else merged.set(m.name, { key: m.name, title: "", type: "string", default: "", required: false, description: "", options: [], jsonPath: m.jsonPath });
  }
  return [...merged.values()];
}
const triggerCfg = computed(() => {
  const t = current.value.spec_json.trigger ?? (current.value.spec_json.trigger = {});
  if (!Array.isArray(t.params)) t.params = mergeLegacyTrigger(t);
  delete t.manual; // 归一后不再保留旧结构，避免保存回旧字段
  delete t.webhook;
  return t;
});
const triggerParams = computed(() => triggerCfg.value.params);
const triggerTab = ref("manual");
// 触发节点 kind 与浮窗 tab 双向同步；镜像写顶层 spec.trigger.kind（后端不读，仅语义化）
watch(triggerTab, (v) => {
  const t = nodes.value.find((n) => isTrigger(n));
  if (t) { t.kind = v; current.value.spec_json.trigger.kind = v; }
});

// ---------- Webhook 触发地址：由后端生成下发，前端只读展示 + 复制，不再本地拼接 ----------
const HOOK_URL_PLACEHOLDER = "点击「获取地址」将自动保存并生成触发地址";
const webhookUrl = ref(""); // 后端下发的完整触发地址（含 ?secret=）；为空即降级为占位
const hookLoading = ref(false);
const resetArmed = ref(false); // 「重置密钥」两段式确认：先点亮，再确认执行
let resetArmTimer = null;
let hookAutoFor = null; // 已自动拉取过地址的流水线 id，保证「切入 Webhook tab 自动拉一次」不重复请求

function disarmReset() {
  resetArmed.value = false;
  if (resetArmTimer !== null) { clearTimeout(resetArmTimer); resetArmTimer = null; }
}
async function armReset() {
  if (!(await ensureSaved())) return;
  if (resetArmed.value) { disarmReset(); resetHook(); return; }
  resetArmed.value = true;
  resetArmTimer = setTimeout(disarmReset, 6000); // 6 秒内不确认即自动撤销，避免误触轮换密钥
}

async function resetHook() {
  hookLoading.value = true;
  try {
    const r = await resetWebhookSecret(current.value.id);
    hookUrlSet(r, { ok: "已重置访问密钥，触发地址已更新（请同步到 GitHub / GitLab）" });
  } catch (e) {
    notify({ type: "error", message: hookErrText(e, "重置密钥失败") });
  } finally { hookLoading.value = false; }
}

// 统一写入后端下发的地址；无 url 时按接口返回失败处理
function hookUrlSet(r, { ok }) {
  webhookUrl.value = r?.url ?? "";
  if (webhookUrl.value) notify({ type: "success", message: ok });
  else notify({ type: "error", message: "后端未返回触发地址，请重试" });
}
// 错误文案分流：404 归因接口未部署，其余如实透出 message（后端已归一含 requestId）
function hookErrText(e, fallback) {
  if (e?.status === 404) return `${fallback}：后端接口版本过旧，请更新部署后再试`;
  return `${fallback}：${e?.message ?? "未知错误"}`;
}

// quiet=true 用于切入 tab 的自动拉取：成功不弹提示，失败静默降级为占位。
// 未保存时先自动保存（stay 模式，不离开页面），满足「无需先手动保存」的直达体验。
async function loadHook({ quiet = false } = {}) {
  if (!(await ensureSaved())) return;
  hookLoading.value = true;
  try {
    const r = await getPipelineHook(current.value.id);
    webhookUrl.value = r?.url ?? "";
    if (!webhookUrl.value && !quiet) notify({ type: "error", message: "后端未返回触发地址，请重试" });
  } catch (e) {
    webhookUrl.value = "";
    if (!quiet) notify({ type: "error", message: hookErrText(e, "获取触发地址失败") });
  } finally { hookLoading.value = false; }
}

// 已有 id 且未拉过地址时自动拉一次（切进 Webhook tab 或数据回填后）
function maybeAutoLoadHook() {
  if (triggerTab.value !== "webhook" || !current.value.id) return;
  if (hookAutoFor === current.value.id) return;
  hookAutoFor = current.value.id;
  loadHook({ quiet: true });
}

async function copyHook() {
  if (!webhookUrl.value) { notify({ type: "error", message: HOOK_URL_PLACEHOLDER }); return; }
  try { await navigator.clipboard.writeText(webhookUrl.value); notify({ type: "success", message: "已复制 Webhook 触发地址" }); }
  catch { notify({ type: "error", message: "复制失败，请手动复制" }); }
}

// ---------- 调试接收：轮询后端探针展示最近收到的请求体，并可一键生成映射草案 ----------
// 全部为前端会话态（不入库）：离开 Webhook tab、关闭开关、组件卸载都会停掉 interval。
const PROBE_POLL_MS = 3000;   // 轮询间隔
const PROBE_JSON_MAX = 8000;  // pretty JSON 超过该长度只展示前段，避免大 payload 拖慢页面
const PROBE_DRAFT_MAX = 40;   // 一次最多生成的草案条数

const probeOn = ref(false);
const probeBody = ref(null);        // 最近一次收到的请求体（object | null）
const probeReceivedAt = ref(null);  // 后端记录的投递时间（ISO | null）
const probeHttpStatus = ref(null);  // 后端记录的处理结果：200/401/503，null=历史数据
const probePolled = ref(false);     // 是否已成功轮询过一次（区分「等待投递」与「接口不可用」）
const probeMissing = ref(false);    // 后端未部署 webhook-probe 接口（404）：停止轮询并给出说明
let probeTimer = null;
let probeInFlight = false;          // 在途标记：慢网下跳过本轮，避免请求堆积
let probeFailCount = 0;             // 连续非 404 失败计数：≥3 自动停轮询，避免无限空转

function stopProbe() {
  if (probeTimer !== null) { clearInterval(probeTimer); probeTimer = null; }
}
async function pollProbe() {
  const id = current.value.id;
  if (!id || probeInFlight) return;
  probeInFlight = true;
  try {
    const r = await fetchWebhookProbe(id);
    if (id !== current.value.id) return;      // 期间切换了流水线，丢弃过期响应
    probeBody.value = r?.body ?? null;        // receivedAt 变化即整体刷新
    probeReceivedAt.value = r?.receivedAt ?? null;
    probeHttpStatus.value = r?.httpStatus ?? null;
    probePolled.value = true;
    probeFailCount = 0;
  } catch (e) {
    if (e?.status === 404) { probeMissing.value = true; probeForceStop(); return; }
    // 其余失败静默重试，连续 3 次判定后端不可达，自动关闭避免每 3 秒空打
    if (++probeFailCount >= 3) {
      probeFailCount = 0;
      probeForceStop();
      notify({ type: "error", message: "调试接收暂时无法连接后端，已自动停止轮询" });
    }
  } finally { probeInFlight = false; }
}
function probeForceStop() { probeOn.value = false; stopProbe(); }
async function startProbe() {
  stopProbe();
  if (!probeOn.value) return;
  // 未保存时先自动保存（stay 模式），保存成功才开始轮询
  if (!(await ensureSaved())) { probeOn.value = false; return; }
  probeMissing.value = false;                      // 重新开启即清掉上一轮「接口不可用」标记
  pollProbe();                                     // 开关即先拉一次，不必等满 3 秒
  probeTimer = setInterval(pollProbe, PROBE_POLL_MS);
}
watch(probeOn, (v) => { if (v) startProbe(); else stopProbe(); });
// 切 tab：离开 Webhook 立即停轮询并清空调试视图；进入则补一次地址自动拉取（探针数据后端持久，重开即回显）
watch(triggerTab, (v) => {
  if (v === "webhook") { maybeAutoLoadHook(); return; }
  stopProbe();            // 显式清理，不依赖 probeOn 侦听的异步 flush
  probeOn.value = false;
  clearProbeView();
  disarmReset();
});

function clearProbeView() {
  probePolled.value = false;
  probeMissing.value = false;
  probeBody.value = null;
  probeReceivedAt.value = null;
  probeHttpStatus.value = null;
  probeFailCount = 0;
}

function resetHookSession() {
  stopProbe();
  disarmReset();
  webhookUrl.value = "";
  hookAutoFor = null;
  probeOn.value = false;
  probePolled.value = false;
  probeMissing.value = false;
  probeBody.value = null;
  probeReceivedAt.value = null;
  probeHttpStatus.value = null;
  probeFailCount = 0;
}
onBeforeUnmount(() => { stopProbe(); disarmReset(); }); // 卸载清理定时器，防泄漏

const PROBE_GUIDE = "开着这个页面，去 GitHub / GitLab 保存并触发一次 Webhook，这里会实时显示收到的请求体。";
const probeHasBody = computed(() => {
  const b = probeBody.value;
  if (!b || typeof b !== "object") return false;
  return Array.isArray(b) ? b.length > 0 : Object.keys(b).length > 0;
});
const probeTimeText = computed(() => {
  const raw = probeReceivedAt.value;
  if (!raw) return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? String(raw) : d.toLocaleString();
});
// 处理结果文案：让用户明确「能收到 ≠ 触发成功」（密钥不匹配/未配置时后端也记录）
const PROBE_STATUS_TEXT = {
  200: "已接收 · 触发成功",
  401: "已接收 · 密钥不匹配（请同步最新触发地址到第三方平台）",
  503: "已接收 · 此流水线未配置访问密钥",
};
const probeStatusText = computed(() => {
  const s = probeHttpStatus.value;
  return s && PROBE_STATUS_TEXT[s] ? PROBE_STATUS_TEXT[s] : "已接收";
});
const probeStatusCls = computed(() => {
  const s = probeHttpStatus.value;
  if (s === 200) return "ok";
  if (s === 401 || s === 503) return "bad";
  return "";
});
const probeJsonText = computed(() => {
  if (!probeHasBody.value) return "";
  try {
    const t = JSON.stringify(probeBody.value, null, 2);
    return typeof t === "string" ? t : String(probeBody.value);
  } catch { return String(probeBody.value); }
});
const probeJsonOverflow = computed(() => probeJsonText.value.length > PROBE_JSON_MAX);
const probeJsonShown = computed(() => (probeJsonOverflow.value ? probeJsonText.value.slice(0, PROBE_JSON_MAX) : probeJsonText.value));
const probeEmptyText = computed(() => {
  if (probeMissing.value) return "当前后端未部署调试接收接口（webhook-probe），升级后即可在此查看真实投递的请求体。";
  return probeOn.value ? PROBE_GUIDE : `开启「调试接收」后每 ${PROBE_POLL_MS / 1000} 秒拉取一次。${PROBE_GUIDE}`;
});

// 请求体 → JSONPath 映射草案：遍历逻辑见 lib/webhookDraft.js（深度 ≤ 2、name sanitize + 去重、上限 40 条）
const probeDrafts = computed(() => (probeHasBody.value ? buildMappingDraft(probeBody.value, { max: PROBE_DRAFT_MAX }) : []));
// 追加：与现有统一触发参数按 key 去重，只增不覆盖；草案补齐统一 params 的全部字段
function appendProbeDrafts() {
  const drafts = probeDrafts.value;
  if (!drafts.length) { notify({ type: "error", message: "请求体里没有可提取的字段，未生成映射草案" }); return; }
  const exists = new Set(triggerParams.value.map((p) => p?.key).filter(Boolean));
  let added = 0;
  for (const d of drafts) {
    if (exists.has(d.name)) continue;
    exists.add(d.name);
    triggerParams.value.push({
      key: d.name, title: "", type: "string", default: "", required: false, description: "", options: [],
      jsonPath: d.jsonPath, // jsonPath 由草案直接带入，manual 触发时忽略该字段走表单/default
    });
    added++;
  }
  notify({
    type: "success",
    message: added ? `已追加 ${added} 条触发参数（含 JSONPath）` : `草案 ${drafts.length} 条与现有参数重名，未追加新行`,
  });
}

// 数据回填后（编辑态）若在 Webhook tab 也补拉一次地址
watch(() => current.value.id, () => maybeAutoLoadHook());
</script>

<template>
  <div class="editor-page">
    <!-- 顶部工具栏 -->
    <header class="topbar">
      <button class="btn btn-ghost" @click="back">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        返回列表
      </button>

      <div class="tb-name-wrap">
        <template v-if="nameEditing">
          <input :id="nameInputEl" class="tb-name-input display" v-model="nameDraft"
            @keydown.enter="commitName" @keydown.esc="cancelName" @blur="commitName" />
        </template>
        <template v-else>
          <h1 class="tb-name display" :title="current.id ? '名称是 Webhook 触发地址的一部分，改名并保存后需重新复制触发地址' : ''">{{ current.name || "未命名流水线" }}</h1>
          <button type="button" class="btn btn-sm btn-ghost tb-name-edit" title="重命名流水线" @click="startNameEdit">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
          </button>
        </template>
      </div>

      <span class="toolbox-spacer"></span>

      <button class="btn btn-ghost" title="按依赖关系重新排布所有节点" @click="autoLayout">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9a2 2 0 1 0 0-.01M12 9a2 2 0 1 0 0-.01M20 9a2 2 0 1 0 0-.01M4 15a2 2 0 1 0 0-.01M12 15a2 2 0 1 0 0-.01M20 15a2 2 0 1 0 0-.01M4 21a2 2 0 1 0 0-.01M12 21a2 2 0 1 0 0-.01M20 21a2 2 0 1 0 0-.01"/></svg>
        自动布局
      </button>
      <button class="btn btn-ghost" title="恢复到适合视角" @click="fitAllNodes">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
        回到原位
      </button>
      <button class="btn" @click="run" :disabled="!current.id" title="配置触发参数并运行">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        运行
      </button>
      <button class="btn btn-accent" @click="save({ stay: true })" :disabled="saving">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8"/></svg>
        {{ saving ? "保存中…" : "保存" }}
      </button>
    </header>

    <!-- 编辑体：左节点库 + 画布 + 悬浮浮窗 -->
    <div class="editor-body">
      <!-- 左栏：节点库（点击添加 / 拖入画布） -->
      <aside class="node-lib">
        <span class="mono-tag">节点库</span>
        <button v-for="k in LIB_TYPES" :key="k" class="btn node-add lib-item" :class="k"
          draggable="true" :title="`${NODE_KINDS[k].label}：点击添加，或拖到画布上指定位置`"
          @dragstart="onLibDragStart($event, k)" @click="addNode(k)">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="NODE_KINDS[k].icon" /></svg>
          {{ NODE_KINDS[k].label }}
        </button>
        <p class="toolbox-hint muted">点击添加，或拖入画布指定位置</p>
      </aside>

      <!-- 中区：画布（撑满） -->
      <main class="canvas-zone" @dragover.prevent="onCanvasDragOver" @drop.prevent="onCanvasDrop">
        <div class="canvas-grd"></div>
        <VueFlow
          :nodes="vfNodes"
          :edges="vfEdges"
          :no-drag-class-name="'nodrag'"
          class="cflow"
          @nodes-change="onNodesChange"
          @edges-change="onEdgesChange"
          @connect="onConnect"
          @node-click="onNodeClick"
          @pane-click="onPaneClick"
          @edge-click="onEdgeClick"
          @edge-mouse-enter="onEdgeMouseEnter"
          @edge-mouse-leave="onEdgeMouseLeave"
        >
          <template #node-dag-node="{ data }">
            <div class="canvas-node" :data-type="data.n.type" :class="{ 'is-trigger': isTrigger(data.n) }">
              <Handle v-if="!isTrigger(data.n)" type="target" :position="Position.Left" />
              <span class="cn-ico" :style="{ color: NODE_KINDS[data.n.type].accent }">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="NODE_KINDS[data.n.type].icon" /></svg>
              </span>
              <div class="cn-main">
                <span class="cn-name" :title="data.n.name || NODE_KINDS[data.n.type].label">{{ data.n.name || NODE_KINDS[data.n.type].label }}</span>
                <span class="cn-id mono">{{ drainId(data.n.id) }}</span>
              </div>
              <button v-if="!isTrigger(data.n)" class="cn-del nodrag" title="删除节点" @mousedown.stop.prevent @click.stop="removeNodeById(data.n.id)">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
              </button>
              <Handle type="source" :position="Position.Right" />
            </div>
          </template>

          <template #edge-default="slot">
            <BaseEdge :id="slot.id" :path="edgePath(slot)" :style="slot.style"
              :marker-start="slot.markerStart" :marker-end="slot.markerEnd"
              :label-x="slot.labelX" :label-y="slot.labelY" />
            <EdgeLabelRenderer>
              <div v-if="hoverEdgeId === slot.id" class="edge-del nodrag" :style="edgeDelStyle(slot)"
                title="删除连线" @mousedown.prevent.stop @click.stop="removeEdgeByData(slot.data)"
                @mouseenter="onEdgeDelMouseEnter(slot.id)">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </div>
              <div v-if="slot.data?.cond" class="edge-cond nodrag" :style="edgeDelStyle(slot)"
                title="点击边配置条件" @click.stop="selectEdge(slot.id)">
                <span class="mono">{{ slot.data.cond.op }} {{ String(slot.data.cond.val ?? "") }}</span>
              </div>
              <div v-else-if="hoverEdgeId !== slot.id" class="edge-cond edge-cond-default nodrag" :style="edgeDelStyle(slot)"
                title="无条件边（默认激活）" @click.stop="selectEdge(slot.id)">
                <span class="mono">默认</span>
              </div>
            </EdgeLabelRenderer>
          </template>
        </VueFlow>

        <div v-if="!current.spec_json.nodes.some((n) => !isTrigger(n))" class="empty">
          <p class="display" style="font-size:15px;color:var(--text-2);margin:0 0 6px">从左侧节点库添加节点</p>
          <p>点击添加，或拖入画布指定落点；节点右侧手柄拖到目标节点左侧手柄建立依赖。</p>
        </div>
      </main>

      <!-- 悬浮参数浮窗：选中节点或边时显示，可拖动/关闭 -->
      <Transition name="float">
        <div v-if="selected || selEdge" class="param-float" :style="floatPos" @mousedown.stop>
          <div class="float-head" @mousedown="startFloatDrag">
            <template v-if="selEdge && !selected">
              <span class="cfg-kind" style="background: var(--line-strong)">边条件</span>
              <span class="cfg-id mono">{{ drainId(selEdge.from) }} → {{ drainId(selEdge.to) }}</span>
              <span class="toolbox-spacer"></span>
              <button type="button" class="btn btn-sm btn-ghost" title="收起" @mousedown.stop @click="selEdgeId = ''">×</button>
            </template>
            <template v-else>
              <span class="cfg-kind" :style="{ backgroundColor: NODE_KINDS[selected.type].accent }">{{ NODE_KINDS[selected.type].label }}</span>
              <template v-if="!isTrigger(selected)">
                <input class="cfg-name-input" v-model="selected.name" :placeholder="NODE_KINDS[selected.type].label" title="节点名称（执行详情页展示用）" @mousedown.stop />
              </template>
              <span class="cfg-id mono">{{ drainId(selected.id) }}</span>
              <span class="toolbox-spacer"></span>
              <button type="button" class="btn btn-sm btn-ghost" title="收起" @mousedown.stop @click="selectedId = ''">×</button>
            </template>
          </div>

          <div class="float-body">
            <template v-if="selEdge && !selected">
              <div class="field">
                <label class="field-label">条件（JSONPath）</label>
                <input class="input mono" :value="selEdge.cond?.path ?? ''" placeholder="如 $.trigger.branch，或 $.outputs.shell1.code" @input="setEdgeCond(selEdge, { path: $event.target.value })" />
                <p class="field-hint">从触发载荷 / 上游节点输出 / 环境变量取值；留空表示无条件边（默认激活）。</p>
              </div>
              <div class="field" v-if="selEdge.cond">
                <label class="field-label">比较符</label>
                <select class="select" :value="selEdge.cond.op" @change="setEdgeCond(selEdge, { op: $event.target.value })">
                  <option v-for="op in COND_OPS" :key="op" :value="op">{{ COND_OP_LABELS[op] }}（{{ op }}）</option>
                </select>
              </div>
              <div class="field" v-if="selEdge.cond && !['exists', 'empty'].includes(selEdge.cond.op)">
                <label class="field-label">比较值</label>
                <input class="input mono" :value="selEdge.cond.val ?? ''" placeholder="字面量（字符串/数字/布尔）" @input="setEdgeCond(selEdge, { val: $event.target.value })" />
              </div>
              <div class="sql-actions" v-if="selEdge.cond">
                <button type="button" class="btn btn-sm btn-ghost" @click="selEdge.cond = null">设为无条件边</button>
              </div>
              <p class="field-hint">若在「无条件边」与「条件边」间切换，请点选下方按钮或清空 path。</p>
            </template>
            <template v-if="isTrigger(selected)">
              <div class="trig-head">
                <span class="mono-tag">触发源</span>
                <div class="seg-tabs">
                  <button type="button" class="seg-tab" :class="{ active: triggerTab === 'manual' }" @click="triggerTab = 'manual'">手动触发</button>
                  <button type="button" class="seg-tab" :class="{ active: triggerTab === 'webhook' }" @click="triggerTab = 'webhook'">Webhook 触发</button>
                </div>
              </div>

              <!-- 统一触发参数编辑器：manual 与 webhook 共用一份 params，webhook tab 额外展示 JSONPath 列 -->
              <template v-if="triggerTab === 'manual'">
                <p class="field-hint trig-desc">运行弹窗将按此 schema 渲染表单；填写的值作为执行期变量注入，可用 <code class="mono ph-code">${key}</code> 引用。切到 Webhook tab 可为同一份参数补配 JSONPath。</p>
                <TriggerParamsEditor :params="triggerParams" />
              </template>

              <!-- webhook 映射编辑器 -->
              <template v-else>
                <div class="field">
                  <div class="field-head">
                    <label class="field-label">Webhook 触发地址</label>
                    <span class="mono-tag">后端生成</span>
                  </div>
                  <div class="group-row">
                    <input class="input mono" :value="webhookUrl" :placeholder="HOOK_URL_PLACEHOLDER" readonly />
                    <button type="button" class="btn btn-sm btn-ghost" @click="copyHook" :disabled="!webhookUrl">复制</button>
                    <button type="button" class="btn btn-sm" @click="loadHook()" :disabled="hookLoading">
                      {{ hookLoading ? "获取中…" : "获取地址" }}
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm"
                      :class="{ 'btn-danger-solid': resetArmed }"
                      :disabled="hookLoading"
                      :title="resetArmed ? '再次点击确认轮换密钥' : '轮换访问密钥并重新生成触发地址'"
                      @click="armReset"
                    >
                      {{ resetArmed ? "确认重置" : "重置密钥" }}
                    </button>
                  </div>
                  <p class="field-hint">
                    地址由后端生成并下发（访问密钥在 URL 末尾 <code class="mono ph-code">?secret=</code> 中），前端不再拼接；
                    复制到 GitHub / GitLab 仓库的 Webhook 配置即触发运行。重置密钥后旧地址立即失效。
                    未保存的流水线点击「获取地址」会先自动保存（不离开本页）。
                  </p>
                </div>

                <!-- 调试接收：轮询后端探针，展示最近收到的请求体并生成映射草案（纯前端会话态） -->
                <div class="probe-panel">
                  <div class="probe-head">
                    <span class="probe-lead">
                      <span class="probe-title display">调试接收</span>
                      <span class="probe-dot" :class="{ live: probeOn && current.id, off: probeMissing }"></span>
                      <span class="probe-state muted">
                        {{ probeMissing ? "接口不可用" : probeOn ? `轮询中 · 每 ${PROBE_POLL_MS / 1000} 秒` : "已停止" }}
                      </span>
                    </span>
                    <label class="switch" title="开启后每 3 秒拉取一次最近收到的 Webhook 请求体（未保存时先自动保存）">
                      <input type="checkbox" v-model="probeOn" />
                      <span class="switch-slider"></span>
                    </label>
                  </div>

                  <div v-if="probePolled" class="probe-meta">
                    <span class="probe-time mono">最近触发：{{ probeTimeText || "尚无投递" }}</span>
                    <span class="probe-status mono" :class="probeStatusCls">{{ probeStatusText }}</span>
                    <button
                      type="button"
                      class="btn btn-sm btn-accent"
                      :disabled="!probeDrafts.length"
                      title="按请求体结构生成 JSONPath 映射草案，追加到下方映射表"
                      @click="appendProbeDrafts"
                    >
                      从请求生成映射草案
                    </button>
                  </div>
                  <template v-if="probeHasBody">
                    <pre class="probe-json mono">{{ probeJsonShown }}{{ probeJsonOverflow ? "\n…" : "" }}</pre>
                    <p v-if="probeJsonOverflow" class="field-hint">
                      请求体共 {{ probeJsonText.length }} 字符，为避免卡顿仅展示前 {{ PROBE_JSON_MAX }} 字符（映射草案仍按完整结构生成）。
                    </p>
                  </template>
                  <p v-else class="probe-empty muted">{{ probeEmptyText }}</p>
                </div>

                <p class="field-hint trig-desc">与 Manual 参数共用同一份配置（只填一遍）；Webhook 触发时按每行的 JSONPath 从请求体取值，取不到时回退默认值。</p>
                <TriggerParamsEditor :params="triggerParams" show-json />
                <p class="field-hint wh-limits">仅支持 <code class="mono">POST</code> 且 <code class="mono">Content-Type: application/json</code> 的请求体；访问密钥通过 URL 末尾 <code class="mono">?secret=</code> 校验，不支持签名头/HMAC。</p>
              </template>
            </template>

            <div v-else v-for="n in [selected]" :key="n.id">
              <template v-if="n.type === 'shell'">
                <div class="field">
                  <label class="field-label">ECI 凭证 <span class="req">*</span></label>
                  <select class="select" v-model="n.params.credential">
                    <option value="">选择运行载体（阿里云 ECI 凭证）…</option>
                    <option v-for="c in eciCreds" :key="c.name" :value="c.name">{{ c.name }}</option>
                  </select>
                  <p class="field-hint" v-if="!eciCreds.length">暂无 ECI 凭证，请先在「凭证」中创建阿里云 ECI 类型凭证</p>
                  <p class="field-hint" v-else>凭证只提供 AK/SK；地域与网络在下方节点内配置</p>
                </div>
                <div class="field">
                  <label class="field-label">地域 Region <span v-if="n.params.credential" class="req">*</span></label>
                  <select class="select" v-model="n.params.regionId">
                    <option value="" disabled>选择运行地域</option>
                    <option v-for="reg in ECI_REGIONS" :key="reg.id" :value="reg.id">{{ reg.label }}（{{ reg.id }}）</option>
                    <option v-if="n.params.regionId && !ECI_REGIONS.some((r) => r.id === n.params.regionId)" :value="n.params.regionId">其他：{{ n.params.regionId }}</option>
                  </select>
                  <p class="field-hint">选择 ECI 实例部署地域；选择凭证+地域后自动探测可用网络与规格</p>
                </div>
                <div class="field">
                  <label class="field-label">交换机 VSwitch ID <span v-if="n.params.regionId" class="req">*</span></label>
                  <input class="input mono" v-model="n.params.vswitchId" list="shell-vsw-dl" placeholder="选择或输入 vsw-…" />
                  <datalist id="shell-vsw-dl">
                    <option v-for="opt in netVswitches" :key="opt.id" :value="opt.id">{{ opt.name || opt.id }}{{ opt.zoneId ? " · " + opt.zoneId : "" }}</option>
                  </datalist>
                  <p class="field-hint">ECI 实例所在交换机，可下拉选择探测结果或手动输入</p>
                </div>
                <div class="field">
                  <label class="field-label">安全组 ID <span v-if="n.params.regionId" class="req">*</span></label>
                  <input class="input mono" v-model="n.params.securityGroupId" list="shell-sg-dl" placeholder="选择或输入 sg-…" />
                  <datalist id="shell-sg-dl">
                    <option v-for="opt in netSecurityGroups" :key="opt.id" :value="opt.id">{{ opt.name || opt.id }}</option>
                  </datalist>
                  <p class="field-hint">ECI 实例安全组，需放行出网以调用回调</p>
                </div>
                <section class="field net-card">
                  <div class="net-head">
                    <span class="net-title">网络 / 规格自动探测</span>
                    <div class="net-acts">
                      <template v-if="n.params.credential && n.params.regionId">
                        <a :href="nodeCreateSecurityGroupUrl()" target="_blank" rel="noreferrer" class="btn btn-sm btn-ghost">去创建安全组 ↗</a>
                        <a :href="nodeCreateVswitchUrl()" target="_blank" rel="noreferrer" class="btn btn-sm btn-ghost">去创建交换机 ↗</a>
                        <button type="button" class="btn btn-sm btn-ghost" :disabled="netProbing" @click="probeNodeNetworks(n.params.credential, n.params.regionId)">⟳ 刷新</button>
                      </template>
                      <span v-else class="muted">选择凭证与地域后自动探测</span>
                    </div>
                  </div>
                  <p v-if="netProbing" class="field-hint">正在查询该地域的交换机与安全组…</p>
                  <p v-else-if="netError" class="field-hint warn">网络探测失败：{{ netError }}</p>
                  <p v-else-if="netSearched" class="field-hint">已探测：{{ netVswitches.length }} 个交换机、{{ netSecurityGroups.length }} 个安全组（输入框可选）</p>
                </section>
                <div class="field">
                  <label class="field-label">运行镜像</label>
                  <div class="group-row">
                    <select class="select" v-model="n.params.image">
                      <option v-if="!images.length && !imagesLoading" :value="n.params.image" hidden></option>
                      <option v-for="im in images" :key="im.image" :value="im.image">{{ im.name }} · {{ im.image }}</option>
                    </select>
                    <button type="button" class="btn btn-sm btn-ghost refresh-btn" title="加载/刷新镜像" @click="loadImages" :disabled="imagesLoading">⟳</button>
                  </div>
                  <p v-if="!images.length" class="field-hint">{{ imagesLoading ? "加载中…" : "暂无镜像，点击右侧刷新图标加载" }}</p>
                </div>
                <div class="field">
                  <label class="field-label">Shell 命令</label>
                  <textarea class="textarea mono autofit" v-model="n.params.command" rows="2" placeholder="echo 'hello cloudshuttle'" @focus="onFieldFocus($event, n, 'command')" @input="autofit"></textarea>
                  <div class="var-insert">
                    <div class="vi-wrap" @click.stop>
                      <button type="button" class="btn btn-sm vi-btn" @click="toggleVarDrop(n.id + ':command')">
                        插入变量
                        <svg class="vi-caret" :class="{ flip: varDrop === n.id + ':command' }" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
                      </button>
                      <div v-if="varDrop === n.id + ':command'" class="vi-drop">
                        <template v-for="grp in varGroups(n)" :key="grp.g">
                          <div class="vi-group">{{ grp.g }}</div>
                          <button v-for="it in grp.items" :key="it.k" type="button" class="vi-item" @click="insertVar(it.k, n, 'command')">
                            <span class="vi-l1"><code class="vi-key mono">{{ "${" + it.k + "}" }}</code><span class="vi-title">{{ it.t }}</span></span>
                            <span v-if="it.d" class="vi-desc">{{ it.d }}</span>
                          </button>
                        </template>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="field">
                  <label class="field-label">附加环境变量（K=V）</label>
                  <div class="kv-list">
                    <div v-for="(e, ei) in n.params.env || []" :key="ei" class="kv-row">
                      <input class="input mono kv-key" v-model="e.k" placeholder="KEY" />
                      <div class="kv-val">
                        <input class="input mono" v-model="e.v" placeholder="value（可用 ${} 引用变量）" @focus="onFieldFocus($event, n, 'env:' + ei + ':v')" />
                        <div class="var-insert">
                          <div class="vi-wrap" @click.stop>
                            <button type="button" class="btn btn-sm vi-btn" @click="toggleVarDrop(n.id + ':env:' + ei)">＋ 变量</button>
                            <div v-if="varDrop === n.id + ':env:' + ei" class="vi-drop">
                              <template v-for="grp in varGroups(n)" :key="grp.g">
                                <div class="vi-group">{{ grp.g }}</div>
                                <button v-for="it in grp.items" :key="it.k" type="button" class="vi-item" @click="insertVar(it.k, n, 'env:' + ei + ':v')">
                                  <span class="vi-l1"><code class="vi-key mono">{{ "${" + it.k + "}" }}</code><span class="vi-title">{{ it.t }}</span></span>
                                  <span v-if="it.d" class="vi-desc">{{ it.d }}</span>
                                </button>
                              </template>
                            </div>
                          </div>
                        </div>
                      </div>
                      <button type="button" class="btn btn-sm btn-danger" title="删除" @click="n.params.env.splice(ei, 1)">×</button>
                    </div>
                    <button type="button" class="btn btn-sm btn-ghost" @click="(n.params.env = n.params.env || []).push({ k: '', v: '' })">＋ 添加环境变量</button>
                  </div>
                </div>
                <div class="field">
                  <div class="field-head">
                    <label class="field-label">输出变量（K=V 写回，供后继节点引用）</label>
                    <button type="button" class="btn btn-sm btn-ghost" title="从 Shell 命令中识别写回 $CLOUDSHUTTLE_OUT_FILE 的变量" @click="autoProbeOutputs(n)">↻ 从命令提取</button>
                  </div>
                  <TriggerParamsEditor :params="n.params.outputs ?? (n.params.outputs = [])" :show-required="false" />
                  <p class="field-hint">脚本内可用 <code class="mono ph-code">echo "key=value" >> "$CLOUDSHUTTLE_OUT_FILE"</code> 写回；未声明 key 时默认输出单变量 <code class="mono ph-code">step_out</code>。</p>
                </div>
                <div class="field">
                  <label class="field-label">运行规格</label>
                  <div class="approval-grid">
                    <div class="sub-field">
                      <label class="sub-label">CPU（vCPU）</label>
                      <select class="select" v-model="n.params.cpu" @change="normMemFor(n)">
                        <option v-for="c in cpuChoices" :key="c" :value="c">{{ c }}</option>
                      </select>
                    </div>
                    <div class="sub-field">
                      <label class="sub-label">内存（GiB）</label>
                      <select class="select" v-model="n.params.memory">
                        <template v-for="mc in memChoicesOf(n.params.cpu)" :key="mc.memory">
                          <option :value="mc.memory">{{ mc.memory }} {{ priceSuffix(mc) }}</option>
                        </template>
                      </select>
                    </div>
                  </div>
                  <p class="field-hint" :class="{ warn: eciSpecError }">
                    {{ eciSpecLoading
                      ? "正在从阿里云探测可购规格与目录价…"
                      : (eciSpecError
                          ? `规格探测失败，已回退预设：${eciSpecError}`
                          : n.params.credential && n.params.regionId
                            ? "已加载该地域可购规格与目录价（来自阿里云接口）；价格单位 ¥/小时"
                            : "选择 ECI 凭证与地域后自动加载规格与目录价") }}
                  </p>
                </div>
                <div class="field">
                  <label class="field-label">超时（秒）</label>
                  <input class="input mono" v-model.number="n.params.timeout" placeholder="300" />
                  <p class="field-hint">容器运行超时上限，到期未完成会被强制终止，单位秒</p>
                </div>
              </template>
              <template v-else-if="n.type === 'branch'">
                <p class="field-hint">条件分支：为出边设置条件——选中连线后在画布上点击连线，浮窗切换为边配置。未命中条件的边及其下游节点将被跳过（执行详情显示「已跳过」）。</p>
                <p class="field-hint">不带条件的边恒激活，可作为默认兜底分支。</p>
              </template>
              <template v-else-if="n.type === 'join'">
                <p class="field-hint">汇聚点：等待所有已激活上游完成后放行；作为循环出口时由循环自动收敛。</p>
              </template>
              <template v-else-if="n.type === 'loop'">
                <div class="field">
                  <label class="field-label">迭代来源</label>
                  <div class="seg-tabs">
                    <button type="button" class="seg-tab" :class="{ active: loopItemsModeOf(n) === 'count' }" @click="setLoopItemsMode(n, 'count')">固定次数</button>
                    <button type="button" class="seg-tab" :class="{ active: loopItemsModeOf(n) === 'path' }" @click="setLoopItemsMode(n, 'path')">JSONPath 数组</button>
                  </div>
                  <input v-if="loopItemsModeOf(n) === 'count'" class="input mono" type="number" min="1" v-model.number="n.params.items.count" placeholder="循环次数，如 3" />
                  <input v-else class="input mono" v-model="n.params.items.path" placeholder="从触发载荷/上游输出取数组，如 $.trigger.refs" @focus="onFieldFocus($event, n, 'items:path')" />
                  <p class="field-hint">每轮注入 <code class="mono ph-code">${item}</code>（当前元素）与 <code class="mono ph-code">${iteration}</code>（1 起始序号）供循环体节点引用。</p>
                </div>
                <div class="field">
                  <label class="field-label">输出累积</label>
                  <div v-for="(a, i) in n.params.accumulate" :key="i" class="sql-out-row">
                    <input class="input mono" v-model="a.key" placeholder="输出 key" />
                    <select class="select" v-model="a.from">
                      <option value="">循环体节点…</option>
                      <option v-for="b in loopBody(n)" :key="b.id" :value="b.id">{{ b.name || drainId(b.id) }}</option>
                    </select>
                    <input class="input mono" v-model="a.field" placeholder="输出字段" />
                    <button type="button" class="btn btn-sm btn-danger" @click="n.params.accumulate.splice(i, 1)">删</button>
                  </div>
                  <div class="sql-actions">
                    <button type="button" class="btn btn-sm btn-ghost" @click="addAccumulate(n)">＋添加累积</button>
                  </div>
                  <p class="field-hint">每轮从所选循环体节点的输出取字段值累积成数组；循环结束后以 JSON 字符串注入该 key（如 <code class="mono ph-code">${shas}</code>）供下游引用。</p>
                </div>
              </template>
              <template v-else-if="n.type === 'sql'">
                <div class="field">
                  <label class="field-label">数据库凭证 <span class="req">*</span></label>
                  <select class="select" v-model="n.params.credential">
                    <option value="">选择数据库连接凭证…</option>
                    <option v-for="c in sqlCreds" :key="c.name" :value="c.name">{{ c.name }}</option>
                  </select>
                  <p class="field-hint" v-if="!sqlCreds.length">暂无数据库凭证，请先在「凭证」中创建 MySQL 或 PostgreSQL 类型凭证</p>
                  <p class="field-hint" v-else>凭证提供连接信息；TLS/字符集等额外参数在凭证里配置</p>
                </div>
                <div class="field">
                  <label class="field-label">SQL 语句（在一个事务内逐条执行）<span class="req">*</span></label>
                  <div v-for="(stmt, i) in n.params.statements" :key="i" class="sql-stmt-row">
                    <textarea class="textarea mono" v-model="n.params.statements[i]" rows="3" placeholder="支持 ${变量}，引用前驱节点输出或触发参数"></textarea>
                    <button type="button" class="btn btn-sm btn-danger" @click="n.params.statements.splice(i, 1)">删</button>
                  </div>
                  <div class="sql-actions">
                    <button type="button" class="btn btn-sm btn-ghost" @click="n.params.statements.push('')">＋添加一条语句</button>
                  </div>
                </div>
                <div class="field">
                  <label class="field-label">输出变量</label>
                  <div v-for="(o, i) in n.params.outputs" :key="i" class="sql-out-row">
                    <input class="input mono" v-model="o.key" placeholder="变量 key" />
                    <input class="input mono" v-model="o.column" placeholder="列名（可选，绑最后结果集首行）" />
                    <button type="button" class="btn btn-sm btn-danger" @click="n.params.outputs.splice(i, 1)">删</button>
                  </div>
                  <div class="sql-actions">
                    <button type="button" class="btn btn-sm btn-ghost" @click="n.params.outputs.push({ key: '', column: '' })">＋添加输出</button>
                  </div>
                  <p class="field-hint">填写列名时按该列取值；不填列名则输出最后一条语句的影响/返回行数</p>
                </div>
                <div class="field">
                  <label class="field-label">超时（秒，可选）</label>
                  <input class="input mono" type="number" v-model.number="n.params.timeout" placeholder="如 60" />
                  <p class="field-hint">后端直连执行；超出视为失败并回滚，防止长 SQL 阻塞请求</p>
                </div>
              </template>
              <template v-else>
                <div class="approval-grid">
                  <div class="field">
                    <label class="field-label">钉钉机器人</label>
                    <div class="group-row">
                      <div class="cs-select" @click.stop>
                        <button type="button" class="cs-trigger" :class="{ open: robotOpenId === n.id }" @click.stop="toggleRobotDrop(n.id)" :disabled="credsLoading">
                          <template v-if="selectedCred(n)">
                            <img v-if="selectedCred(n)?.display_meta?.appIcon" :src="selectedCred(n).display_meta.appIcon" class="cs-ico" alt="" />
                            <span v-else class="cs-badge" :style="{ color: isCorpRobot(n.params.robot) ? 'var(--ember)' : '' }">{{ KIND_BADGE[selectedCred(n).kind] }}</span>
                            <span class="cs-trigger-text">
                              <span class="cs-title">{{ credTitle(selectedCred(n)) }}</span>
                              <span class="cs-sub">{{ credSub(selectedCred(n)) }}</span>
                            </span>
                          </template>
                          <span v-else class="cs-placeholder">{{ credsLoading ? "加载中…" : "请选择机器人" }}</span>
                          <svg class="cs-caret" :class="{ flip: robotOpenId === n.id }" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
                        </button>
                        <div v-if="robotOpenId === n.id" class="cs-drop">
                          <div
                            v-for="c in robotCreds"
                            :key="c.id"
                            class="cs-opt"
                            :class="{ active: n.params.robot === c.name }"
                            @click="pickRobot(n, c.name)"
                          >
                            <img v-if="c.display_meta?.appIcon" :src="c.display_meta.appIcon" class="cs-opt-ico" alt="" />
                            <span v-else class="cs-opt-badge">{{ KIND_BADGE[c.kind] || "凭证" }}</span>
                            <span class="cs-opt-text">
                              <span class="cs-opt-title">{{ credTitle(c) }}</span>
                              <span class="cs-opt-sub">{{ credSub(c) }}</span>
                            </span>
                            <svg v-if="n.params.robot === c.name" class="cs-check" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                          </div>
                          <div v-if="!robotCreds.length && !credsLoading" class="cs-empty">暂无审批机器人，点右侧刷新图标加载</div>
                        </div>
                      </div>
                      <button type="button" class="btn btn-sm btn-ghost refresh-btn" title="加载/刷新机器人" @click="loadCreds" :disabled="credsLoading">⟳</button>
                    </div>
                    <p v-if="!robotCreds.length" class="field-hint">{{ credsLoading ? "加载中…" : "暂无审批机器人，点击右侧刷新图标加载" }}</p>
                  </div>
                </div>

                <div v-if="isCorpRobot(n.params.robot)" class="approval-grid" style="margin-top:14px">
                  <div class="field" style="grid-column:1/-1">
                    <div class="field-head">
                      <label class="field-label">审批卡片正文（Markdown）</label>
                      <div class="card-tabs">
                        <button type="button" class="card-tab" :class="{ active: cardModeOf(n) === 'edit' }" @click="cardModes[n.id] = 'edit'">编辑</button>
                        <button type="button" class="card-tab" :class="{ active: cardModeOf(n) === 'preview' }" @click="cardModes[n.id] = 'preview'">预览</button>
                        <button type="button" class="btn btn-sm" title="还原为内置默认模板" @click="resetApprovalMsg(n)">恢复默认</button>
                      </div>
                    </div>
                    <template v-if="cardModeOf(n) === 'edit'">
                      <textarea
                        class="textarea mono card-body autofit"
                        v-model="n.params.message"
                        rows="4"
                        placeholder="编写审批卡片正文（支持 Markdown），点击下方变量标签可插入。"
                        @focus="onFieldFocus($event, n, 'message')"
                        @input="autofit"
                      ></textarea>
                      <div class="var-insert">
                        <div class="vi-wrap" @click.stop>
                          <button type="button" class="btn btn-sm vi-btn" @click="toggleVarDrop(n.id + ':message')">
                            插入变量
                            <svg class="vi-caret" :class="{ flip: varDrop === n.id + ':message' }" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
                          </button>
                          <div v-if="varDrop === n.id + ':message'" class="vi-drop">
                            <template v-for="grp in varGroups(n)" :key="grp.g">
                              <div class="vi-group">{{ grp.g }}</div>
                              <button v-for="it in grp.items" :key="it.k" type="button" class="vi-item" @click="insertVar(it.k, n, 'message')">
                                <span class="vi-l1"><code class="vi-key mono">{{ "${" + it.k + "}" }}</code><span class="vi-title">{{ it.t }}</span></span>
                                <span v-if="it.d" class="vi-desc">{{ it.d }}</span>
                              </button>
                            </template>
                          </div>
                        </div>
                      </div>
                    </template>
                    <div v-else class="md-render" v-html="approvalHtml(n)"></div>
                  </div>

                  <div class="field" style="grid-column:1/-1">
                    <div class="field-head">
                      <label class="field-label">发送成员</label>
                      <button type="button" class="btn btn-sm" @click="openOrg(n)">＋ 从通讯录选择</button>
                    </div>
                    <div class="member-list">
                      <div v-for="(m, i) in displayMembers(n)" :key="i" class="member-row">
                        <span v-if="m.dept" class="member-dept">{{ m.dept }}</span>
                        <span class="member-name">{{ m.name }}</span>
                        <button v-if="m.userId" type="button" class="member-del" title="移除该成员" @click="removeMember(n, i)">×</button>
                      </div>
                      <div v-if="!displayMembers(n).length" class="empty-tip muted">未选择审批人，点右上「从通讯录选择」按部门树勾选。</div>
                    </div>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>
      </Transition>
    </div>

    <!-- 通讯录成员选择器 -->
    <div v-if="orgOpen" class="org-mask" @click.self="orgOpen = false">
      <div class="org-panel">
        <div class="org-head">
          <strong>从通讯录选择成员</strong>
          <button type="button" class="btn btn-ghost" @click="orgOpen = false">×</button>
        </div>
        <div v-if="orgLoading" class="org-body muted">加载中…</div>
        <div v-else class="org-body">
          <div class="org-crumb">
            <a @click="orgGotoIndex(0); orgPath = []; orgLoad()">根部门</a>
            <template v-for="(p, i) in orgPath" :key="p.id">
              <span class="org-slash">/</span><a @click="orgPath=orgPath.slice(0,i+1); orgLoad()">{{ p.name }}</a>
            </template>
          </div>
          <div v-if="orgDepts.length" class="org-depts">
            <div v-for="d in orgDepts" :key="d.id" class="org-dept" @click="orgGoto(d)">
              📁&nbsp;{{ d.name }}
            </div>
          </div>
          <div class="org-users">
            <label v-for="u in orgUsers" :key="u.userId" class="org-user">
              <input type="checkbox" :checked="orgSel.has(u.userId)" @change="orgToggle(u)" />
              <span>{{ u.name }}</span>
              <span class="muted">{{ u.userId }}</span>
            </label>
            <div v-if="!orgUsers.length" class="muted org-empty">该部门暂无成员</div>
          </div>
        </div>
        <div class="org-foot">
          <span class="org-sel">已选 {{ orgSel.size }}：{{ [...orgSel.values()].map((v) => v.name).join("、") || "—" }}</span>
          <div>
            <button type="button" class="btn btn-ghost" @click="orgOpen = false">取消</button>
            <button type="button" class="btn" @click="orgConfirm">确认</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 运行弹窗（manual 表单） -->
    <RunPipelineModal ref="runModal" />
  </div>
</template>

<style scoped>
.editor-page { height: 100%; display: flex; flex-direction: column; gap: 12px; min-height: 0; width: 100%; }
.topbar {
  flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; border-bottom: 1px solid var(--line);
}
.tb-name-wrap { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tb-name {
  margin: 0; font-size: 17px; font-weight: 700; letter-spacing: .01em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tb-name-input {
  font-family: var(--font-display); font-size: 17px; font-weight: 700;
  width: 320px; max-width: 60vw; padding: 3px 8px; background: var(--bg-1);
  border: 1px solid var(--accent); border-radius: 8px; color: var(--text-1); outline: none;
}
.tb-name-edit { flex: 0 0 auto; }
.editor-body { flex: 1 1 auto; min-height: 0; display: flex; gap: 12px; position: relative; }
.node-lib {
  flex: 0 0 208px; display: flex; flex-direction: column; gap: 8px;
  padding: 14px 12px; background: linear-gradient(180deg, var(--bg-2), var(--bg-1));
  border: 1px solid var(--line); border-radius: var(--radius); overflow-y: auto;
}
.lib-item { justify-content: flex-start; gap: 9px; }
.lib-item.shell { color: var(--accent); background: var(--accent-soft); border-color: transparent; }
.lib-item.shell:hover { background: rgba(84,208,198,.2); }
.lib-item.approval { color: var(--ember); background: var(--warn-soft); border-color: transparent; }
.lib-item.approval:hover { background: rgba(255,192,77,.22); }
.lib-item.sql { color: var(--accent); background: var(--accent-soft); border-color: transparent; }
.lib-item.sql:hover { background: rgba(84,208,198,.2); }
.canvas-zone { position: relative; min-width: 0; flex: 1 1 auto; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-0); }
.canvas-grd {
  position: absolute; inset: 0; pointer-events: none; opacity: .7;
  background-image:
    linear-gradient(rgba(122,160,240,0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(122,160,240,0.05) 1px, transparent 1px);
  background-size: 26px 26px;
}
.cflow { position: absolute; inset: 0; }
.canvas-zone .vue-flow__node { cursor: grab; }
.canvas-zone .vue-flow__node.dragging { cursor: grabbing; }

/* 悬浮参数浮窗（可拖动/关闭，仅选中节点时显示） */
.param-float {
  position: fixed; width: 440px; max-width: calc(100vw - 40px); max-height: calc(100vh - 130px);
  display: flex; flex-direction: column; z-index: 50;
  background: linear-gradient(180deg, var(--bg-2), var(--bg-1));
  border: 1px solid var(--line-strong); border-radius: 14px; box-shadow: 0 18px 48px rgba(0,0,0,.5);
  overflow: hidden;
}
.float-head { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; padding: 10px 12px; border-bottom: 1px solid var(--line); cursor: grab; }
.float-head:active { cursor: grabbing; }
.float-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 14px; }
.float-enter-active, .float-leave-active { transition: opacity .16s var(--ease), transform .16s var(--ease); }
.float-enter-from, .float-leave-to { opacity: 0; transform: translateY(-6px); }
.canvas-node.is-trigger { border-left-color: var(--warn); }
.toolbox-spacer { flex: 1 1 auto; }

/* 画布节点卡片（渲染于 Vue Flow 画布） */
.canvas-node {
  position: relative; display: flex; align-items: center; gap: 8px;
  min-width: 150px; max-width: 230px; padding: 8px 10px;
  background: linear-gradient(180deg, var(--bg-2), var(--bg-1));
  border: 1.5px solid var(--line-strong); border-left: 3px solid var(--accent);
  border-radius: 10px; box-shadow: var(--shadow);
  transition: border-color .16s var(--ease), box-shadow .16s var(--ease);
}
.canvas-node[data-type="approval"] { border-left-color: var(--ember); }
.canvas-node:hover { border-color: var(--accent); }
.canvas-node[data-type="approval"]:hover { border-color: var(--ember); }
.cn-ico {
  width: 26px; height: 26px; flex: 0 0 26px; display: grid; place-items: center;
  border: 1px solid currentColor; border-radius: 7px;
  background: color-mix(in srgb, currentColor 12%, transparent);
}
.cn-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.cn-name { font-size: 12.5px; font-weight: 600; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cn-id { font-size: 9.5px; color: var(--text-3); }
.cn-del {
  flex: 0 0 auto; display: grid; place-items: center; width: 22px; height: 22px;
  color: var(--text-3); background: transparent; border: 1px solid transparent; border-radius: 6px;
  cursor: pointer; opacity: 0; transition: opacity .14s var(--ease);
}
.canvas-node:hover .cn-del { opacity: 1; }
.cn-del:hover { color: #ff6b6b; background: var(--bg-3); border-color: var(--line); }
.canvas-node :deep(.vue-flow__handle) {
  width: 11px; height: 11px; background: var(--bg-2); border: 2px solid var(--accent); border-radius: 50%;
}
.canvas-node :deep(.vue-flow__handle-left) { left: -6px; }
.canvas-node :deep(.vue-flow__handle-right) { right: -6px; }
.canvas-node :deep(.vue-flow__handle:hover) { background: var(--accent); }

/* 边的悬停删除键（渲染于 edge-labels 层，flow 坐标系定位） */
.edge-del {
  position: absolute; width: 26px; height: 26px; display: grid; place-items: center;
  color: var(--text-1); background: var(--bg-2); border: 1px solid var(--line-strong);
  border-radius: 8px; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.3); z-index: 5;
}
.edge-del:hover { color: #ff6b6b; background: var(--bg-3); }
.edge-cond {
  position: absolute; transform: translate(-50%, -50%);
  background: rgba(13, 17, 23, 0.85); color: var(--warn);
  border: 1px solid var(--line); border-radius: 8px;
  padding: 1px 6px; font-size: 11px; line-height: 16px;
  cursor: pointer; pointer-events: auto; white-space: nowrap; z-index: 5;
}
.edge-cond-default { color: var(--text-3); }

/* 右侧节点配置抽屉 */
.cfg-kind {
  flex: 0 0 auto; font-size: 11px; font-weight: 700; letter-spacing: .04em; color: #fff;
  padding: 3px 9px; border-radius: 999px; white-space: nowrap;
}
.cfg-name-input {
  flex: 1; min-width: 0; font-size: 14px; font-weight: 600; color: var(--text-1);
  background: transparent; border: 1px solid transparent; border-radius: 7px;
  padding: 2px 6px; font-family: inherit;
}
.cfg-name-input:hover { border-color: var(--line); background: var(--bg-1); }
.cfg-name-input:focus { outline: none; border-color: var(--accent); background: var(--bg-0); }
.cfg-name-input::placeholder { color: var(--text-3); }
.cfg-id { flex: 0 0 auto; }
.node-list { position: relative; display: flex; flex-direction: column; }

.node-row { display: flex; gap: 22px; align-items: stretch; }
.rail { width: 18px; display: flex; flex-direction: column; align-items: center; padding-top: 30px; }
.rail-dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; box-shadow: 0 0 0 4px rgba(255,255,255,.05); }
.rail-line { width: 2px; flex: 1; min-height: 34px; margin-top: 4px; background: linear-gradient(var(--line-strong), var(--line)); }
.rail-line.fade { opacity: 0; }
.node-row + .node-row .rail-line { display: none; }

.node-card {
  flex: 1; min-width: 0; margin-bottom: 20px;
  background: linear-gradient(180deg, var(--bg-2), var(--bg-1));
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow);
  border-left: 3px solid var(--node-accent);
  transition: border-color .16s var(--ease), transform .16s var(--ease), box-shadow .16s var(--ease);
}
.node-card:hover { border-color: var(--line-strong); }
.node-head {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 16px; border-bottom: 1px solid var(--line);
}
.node-ico {
  width: 34px; height: 34px; flex: 0 0 34px;
  display: grid; place-items: center;
  border: 1px solid; border-radius: 9px;
  background: color-mix(in srgb, var(--node-accent) 12%, transparent);
}
.node-title { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.node-kind { font-size: 14px; font-weight: 600; letter-spacing: .02em; }
.node-name-input {
  font-size: 14px; font-weight: 600; letter-spacing: .02em; color: var(--text-1);
  background: transparent; border: 1px solid transparent; border-radius: 7px;
  padding: 2px 6px; margin: -2px -6px; width: 100%; min-width: 0;
  font-family: inherit;
}
.node-name-input:hover { border-color: var(--line); background: var(--bg-1); }
.node-name-input:focus { outline: none; border-color: var(--accent); background: var(--bg-0); }
.node-name-input::placeholder { color: var(--text-3); }
.node-head-actions { display: flex; gap: 4px; }
.drag-handle { cursor: grab; color: var(--text-3); background: transparent; border-color: transparent; }
.drag-handle:hover { color: var(--text-2); background: var(--bg-3); border-color: var(--line); }
.node-step { font-size: 10px; color: var(--text-3); letter-spacing: .1em; white-space: nowrap; }

.node-body { padding: 16px; }
.approval-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.sub-field { display: flex; flex-direction: column; gap: 5px; }
.sub-field .sub-label { font-size: 12px; color: var(--text-2); }
.net-card { border: 1px dashed var(--line-strong); border-radius: 12px; padding: 10px 14px; background: var(--bg-1); }
.net-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.net-title { font-size: 12.5px; font-weight: 600; color: var(--text-1); }
.net-acts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kind-tabs.mini { display: flex; gap: 8px; }
.kind-tabs.mini .kind-tab {
  flex: 1; justify-content: center; padding: 8px 6px;
  font-family: var(--font-display); font-size: 12px; font-weight: 500;
  color: var(--text-2); background: var(--bg-1); border: 1px solid var(--line);
  border-radius: 9px; cursor: pointer; transition: all .16s var(--ease);
}
.kind-tabs.mini .kind-tab.active {
  color: var(--ember); background: var(--warn-soft); border-color: var(--ember);
}
.group-row { display: flex; gap: 8px; }
.group-row .input { flex: 1; min-width: 0; }
.group-row .select { flex: 1; min-width: 0; }

/* 高级机器人下拉：logo + 主副标题 */
.cs-select { position: relative; flex: 1; min-width: 0; }
.cs-trigger {
  width: 100%; display: flex; align-items: center; gap: 10px;
  padding: 9px 12px; border: 1px solid var(--line); border-radius: 10px;
  background: var(--bg-1); color: var(--text-1); cursor: pointer;
  font-family: inherit; text-align: left; transition: border-color .16s var(--ease), box-shadow .16s var(--ease);
}
.cs-trigger:hover { border-color: var(--line-strong); }
.cs-trigger.open { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent); }
.cs-trigger:disabled { opacity: .6; cursor: progress; }
.cs-ico { width: 30px; height: 30px; flex: 0 0 30px; border-radius: 8px; object-fit: cover; background: var(--bg-3); }
.cs-opt-ico { width: 30px; height: 30px; flex: 0 0 30px; border-radius: 8px; object-fit: cover; background: var(--bg-3); }
.cs-badge, .cs-opt-badge {
  width: 30px; height: 30px; flex: 0 0 30px; border-radius: 8px; display: grid; place-items: center;
  font-family: var(--font-display); font-size: 14px; font-weight: 600;
  color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); border: 1px solid var(--line);
}
.cs-trigger-text, .cs-opt-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.cs-title, .cs-opt-title { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cs-sub, .cs-opt-sub { font-size: 11.5px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cs-placeholder { color: var(--text-3); flex: 1; }
.cs-caret { margin-left: auto; flex: 0 0 auto; color: var(--text-3); transition: transform .18s var(--ease); }
.cs-caret.flip { transform: rotate(180deg); }
.cs-drop {
  position: absolute; top: calc(100% + 6px); left: 0; right: 0; z-index: 40;
  max-height: 260px; overflow: auto; padding: 5px;
  background: var(--bg-2); border: 1px solid var(--line-strong); border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0,0,0,.35);
}
.cs-opt {
  display: flex; align-items: center; gap: 10px; padding: 8px 9px; border-radius: 8px; cursor: pointer;
}
.cs-opt:hover { background: var(--bg-3); }
.cs-opt.active { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.cs-opt-title { color: var(--text-1); }
.cs-opt.active .cs-opt-title { color: var(--accent); }
.cs-check { margin-left: auto; flex: 0 0 auto; color: var(--accent); }
.cs-empty { padding: 12px; text-align: center; color: var(--text-3); font-size: 12.5px; }

/* 审批卡片正文：高度随内容自适应（field-sizing 为主，fit() JS 兜底旧内核） */
.card-body { min-height: 108px; }
.textarea.autofit { resize: none; overflow: hidden; field-sizing: content; }
/* shell 节点附加配置：KV 列表（env / outputs） */
.kv-list { display: flex; flex-direction: column; gap: 6px; }
.kv-row { display: flex; align-items: center; gap: 6px; }
.kv-row .btn-danger { flex: 0 0 auto; }
.kv-key { width: 220px; flex: 0 0 auto; }
.kv-val { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.kv-val > .input { width: 100%; }
/* sql 节点：语句/输出动态列表 */
.sql-stmt-row { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 8px; }
.sql-stmt-row .textarea { flex: 1; min-width: 0; }
.sql-stmt-row .btn-danger { flex: 0 0 auto; margin-top: 2px; }
.sql-out-row { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.sql-out-row .input { flex: 1; min-width: 0; }
.sql-out-row .btn-danger { flex: 0 0 auto; }
.sql-actions { margin: 2px 0 10px; }
/* 插入变量：按钮 + 明细下拉面板（变量名/标题/说明，信息对齐触发源表） */
.var-insert { margin: 8px 0 2px; }
.vi-wrap { position: relative; display: inline-block; }
.vi-btn { display: inline-flex; align-items: center; gap: 5px; }
.vi-caret { color: var(--text-3); transition: transform .18s var(--ease); }
.vi-caret.flip { transform: rotate(180deg); }
.vi-drop {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 45; width: 330px;
  max-height: 300px; overflow: auto; padding: 5px;
  background: var(--bg-2); border: 1px solid var(--line-strong); border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0,0,0,.35);
}
.vi-group { font-size: 10.5px; font-weight: 700; letter-spacing: .06em; color: var(--text-3); padding: 8px 8px 4px; }
.vi-item {
  display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left;
  padding: 7px 8px; border-radius: 8px; cursor: pointer; border: none; background: none;
}
.vi-item:hover { background: var(--bg-3); }
.vi-l1 { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.vi-key { font-size: 12px; color: var(--accent); flex: 0 0 auto; }
.vi-title { font-size: 12px; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vi-desc { font-size: 11px; color: var(--text-2); padding-left: 2px; }
.card-tabs { display: flex; align-items: center; gap: 6px; }
.card-tab {
  font-size: 12px; font-weight: 600; color: var(--text-2);
  padding: 5px 12px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--bg-1); cursor: pointer; transition: all .16s var(--ease);
}
.card-tab:hover { border-color: var(--line-strong); }
.card-tab.active { color: var(--accent); background: var(--accent-soft); border-color: var(--accent); }
.md-render {
  margin-top: 8px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px;
  background: var(--bg-1); font-size: 13px; line-height: 1.7; color: var(--text-1);
}
.md-render :deep(h1), .md-render :deep(h2), .md-render :deep(h3) { margin: 0 0 8px; font-size: 15px; font-weight: 700; }
.md-render :deep(h3:first-child), .md-render :deep(p:first-child) { margin-top: 0; }
.md-render :deep(p) { margin: 4px 0; }
.md-render :deep(table) { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12.5px; }
.md-render :deep(th), .md-render :deep(td) { border: 1px solid var(--line-strong); padding: 5px 9px; text-align: left; }
.md-render :deep(th) { background: var(--bg-3); font-weight: 600; }
.md-render :deep(code) { font-family: var(--font-mono); font-size: 12px; background: var(--bg-3); padding: 1px 5px; border-radius: 5px; }
.md-render :deep(a) { color: var(--accent); }
.md-render :deep(ul), .md-render :deep(ol) { margin: 4px 0; padding-left: 20px; }
.md-render :deep(hr) { border: 0; border-top: 1px solid var(--line); margin: 10px 0; }
.md-render :deep(blockquote) { margin: 6px 0; padding-left: 10px; border-left: 3px solid var(--accent); color: var(--text-2); }

.field-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.field-head .field-label { margin-bottom: 0; }
.field-label .req { color: var(--warn); margin-left: 2px; }

.member-list { border-top: 1px solid rgba(255,255,255,.06); }
.member-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 2px; border-bottom: 1px solid rgba(255,255,255,.06);
}
.member-dept { color: var(--fg-3, rgba(255,255,255,.5)); font-size: 12px; }
.member-dept::after { content: "/"; margin: 0 7px; color: var(--fg-4, rgba(255,255,255,.3)); }
.member-name { font-weight: 600; }
.member-del {
  margin-left: auto; border: 0; background: transparent; color: var(--fg-4, rgba(255,255,255,.45));
  font-size: 18px; line-height: 1; cursor: pointer; padding: 2px 6px; border-radius: 6px;
}
.member-del:hover { color: #ff6b6b; background: var(--bg-3); }
.empty-tip { font-size: 12.5px; padding: 6px 2px; }
.refresh-btn { flex: 0 0 auto; white-space: nowrap; }
.field-hint { margin-top: 6px; font-size: 12px; color: var(--text-2); line-height: 1.5; }
.field-hint.warn { color: var(--ember, #f59e0b); }

.org-mask { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; }
.org-panel { width: 520px; max-width: 92vw; max-height: 80vh; background: var(--bg-2); border: 1px solid var(--line-strong); border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; }
.org-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.org-body { padding: 8px 16px; overflow: auto; flex: 1; min-height: 180px; }
.org-crumb { font-size: 12.5px; margin-bottom: 8px; flex-wrap: wrap; display: flex; }
.org-crumb a { color: var(--accent); cursor: pointer; }
.org-slash { margin: 0 4px; color: var(--text-2); }
.org-depts { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
.org-dept { padding: 7px 10px; cursor: pointer; border-radius: 6px; }
.org-dept:hover { background: var(--bg-3); }
.org-users { display: flex; flex-direction: column; gap: 2px; }
.org-user { display: flex; gap: 8px; align-items: center; padding: 6px 8px; cursor: pointer; border-radius: 6px; }
.org-user:hover { background: var(--bg-3); }
.org-user .muted { font-size: 12px; margin-left: auto; }
.org-empty { padding: 12px 0; }
.org-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--line); }
.org-foot > div { display: flex; gap: 8px; }
.org-sel { font-size: 12.5px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 触发源配置 */
.trig-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.seg-tabs { display: flex; gap: 6px; background: var(--bg-1); border: 1px solid var(--line); border-radius: 9px; padding: 3px; }
.seg-tab {
  font-family: var(--font-display); font-size: 12px; font-weight: 600;
  color: var(--text-2); background: transparent; border: 0; border-radius: 6px;
  padding: 6px 14px; cursor: pointer; transition: all .16s var(--ease);
}
.seg-tab:hover { color: var(--text-1); }
.seg-tab.active { color: var(--accent); background: var(--accent-soft); }
.trig-desc { margin: -4px 0 12px; }
.ph-code { font-size: 11px; color: var(--accent); background: var(--accent-soft); padding: 1px 5px; border-radius: 5px; }

/* 调试接收面板：轮询状态 + 请求体预览 + 映射草案入口 */
.probe-panel {
  margin: 2px 0 14px; padding: 12px 14px;
  background: var(--bg-1); border: 1px solid var(--line); border-radius: 10px;
}
.probe-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.probe-lead { display: flex; align-items: center; gap: 9px; min-width: 0; }
.probe-title { font-size: 13px; font-weight: 600; color: var(--text-1); }
.probe-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); flex: 0 0 7px; }
.probe-dot.live { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); animation: probePulse 1.6s var(--ease) infinite; }
.probe-dot.off { background: var(--err); box-shadow: 0 0 0 3px var(--err-soft); animation: none; }
.probe-state { font-family: var(--font-mono); font-size: 11px; letter-spacing: .03em; }
@keyframes probePulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
.probe-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 12px 0 8px; flex-wrap: wrap; }
.probe-time { font-size: 11.5px; color: var(--accent); }
.probe-status { font-size: 11.5px; padding: 2px 8px; border-radius: 999px; background: var(--bg-3); color: var(--text-2); }
.probe-status.ok { color: var(--ok, #3fb98d); background: var(--ok-soft, rgba(63,185,141,.12)); }
.probe-status.bad { color: var(--err); background: var(--err-soft); }
.wh-limits { margin-top: 10px; }
.probe-json {
  margin: 0; max-height: 260px; overflow: auto; padding: 10px 12px;
  font-size: 11.5px; line-height: 1.55; color: var(--text-1); white-space: pre;
  background: var(--bg-2); border: 1px solid var(--line); border-radius: 8px;
}
.probe-empty {
  margin: 12px 0 0; font-size: 12.5px; line-height: 1.6;
  padding: 12px 14px; border: 1px dashed var(--line-strong); border-radius: 8px;
}
/* 开关（与运行弹窗 boolean 参数同款视觉） */
.switch { position: relative; display: inline-block; width: 40px; height: 22px; flex: 0 0 40px; }
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
.switch input:disabled + .switch-slider { opacity: .5; cursor: not-allowed; }

.node-ghost { opacity: .35; }
</style>