<!-- 流水线编辑页：路由驱动，新建(/pipelines/new) 或 编辑(/pipelines/:id) -->
<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import draggable from "vuedraggable";
import MarkdownIt from "markdown-it";
import { notify } from "../lib/notify.js";
import { buildMappingDraft } from "../lib/webhookDraft.js";
import { getPipeline, createPipeline, updatePipeline, getPipelineHook, resetWebhookSecret, fetchWebhookProbe } from "../api/pipeline.js";
import { fetchImages } from "../api/image.js";
import { fetchCredentials, listDepartments, listDepartmentUsers } from "../api/credential.js";
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

const newPipeline = () => ({
  id: null, name: "", description: "",
  // 统一触发参数：manual 与 webhook 共用一份 params（webhook 用每项的 jsonPath 从请求体取值）
  spec_json: { nodes: [], edges: [], trigger: { params: [] } },
});
const current = ref(newPipeline());
const nodes = computed({ get: () => current.value.spec_json.nodes, set: (v) => (current.value.spec_json.nodes = v) });

// 由路由参数判定是否编辑态：新建/编辑不再依赖返显是否成功
const editingId = computed(() => (route.params.id ? +route.params.id : null));
const isNew = computed(() => !editingId.value);
const pageTitle = computed(() => (isNew.value ? "新建流水线" : `编辑流水线${current.value.name ? " · " + current.value.name : ""}`));

async function hydrate() {
  if (!editingId.value) { current.value = newPipeline(); resetHookSession(); return; }
  try {
    const p = await getPipeline(editingId.value);
    current.value = JSON.parse(JSON.stringify(p));
    resetHookSession(); // 切换流水线：丢弃后端下发的触发地址与调试接收态，避免跨 /pipelines/:id 残留
    // 下拉数据懒加载：仅当节点实际用到镜像/凭证才请求，避免挂载即连拉 3 个接口
    const ns = current.value.spec_json?.nodes ?? [];
    if (ns.some((n) => n.type === "shell" || n.type === "approval")) loadCreds();
    if (ns.some((n) => n.type === "shell")) loadImages();
    nextTick(fitAll); // 回填内容后按内容重算各正文/命令输入框高度
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
        up.push({ k: o.key, t: o.desc || "节点输出", d: "来自节点 " + drainId(id) });
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

const NODE_KINDS = {
  shell:    { label: "Shell 执行",   accent: "var(--accent)",  icon: "M4 5l6 7-6 7m8 0h8" },
  approval: { label: "人工审批",     accent: "var(--ember)",   icon: "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6zm-3.5 6.5L11 12l4-4.5" },
};

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
function resetApprovalMsg(n) { n.params.message = DEFAULT_APPROVAL_BODY; nextTick(fitAll); }
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

const addNode = (type) => {
  // 添加节点后会用到对应下拉，此时再按需加载其数据
  if (type === "shell" || type === "approval") loadCreds();
  if (type === "shell") loadImages();
  const node = {
    id: `n${Date.now()}`,
    type,
    step: type,
    params:
      type === "shell"
        ? { image: images.value[0]?.image ?? "alpine", command: "", env: [], outputs: [{ key: "step_out" }], credential: "" }
        : { robot: "", message: DEFAULT_APPROVAL_BODY, target: { type: "user", openIds: "", members: [] } },
  };
  current.value.spec_json.nodes.push(node);
};

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
    hookAutoFor = null;      // 名称/spec 可能变化，保存后允许重新拉取触发地址
    if (!stay) router.push("/pipelines");
    else if (triggerTab.value === "webhook") loadHook({ quiet: true }); // 留在页面时刷新地址
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
  <div class="page">
    <header class="page-head rise">
      <div class="title-wrap">
        <button class="btn btn-ghost back-btn" @click="back">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          返回列表
        </button>
        <div>
          <h1 class="head-title display">{{ pageTitle }}</h1>
          <p class="head-sub muted">编排 shell 执行与人工审批节点，保存后进入列表。</p>
        </div>
      </div>
      <div class="head-actions">
        <button class="btn" @click="run" :disabled="!current.id" title="配置触发参数并运行">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          运行
        </button>
        <button class="btn btn-accent" @click="save" :disabled="saving">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8"/></svg>
          {{ saving ? "保存中…" : "保存流水线" }}
        </button>
      </div>
    </header>

    <!-- 命名栏 -->
    <section class="name-bar card rise" style="animation-delay:.04s">
      <div class="field name-field">
        <label class="field-label">流水线名称</label>
        <input class="input" v-model="current.name" placeholder="如：release-构建-发布" />
        <p class="field-hint" v-if="current.id">名称是 Webhook 触发地址的一部分，修改并保存后，请重新复制触发地址到第三方平台。</p>
      </div>
      <div class="field">
        <label class="field-label">节点总数</label>
        <div class="mono counter">{{ current.spec_json.nodes.length }}</div>
      </div>
    </section>

    <!-- 工具箱 -->
    <section class="toolbox rise" style="animation-delay:.07s">
      <span class="mono-tag">添加节点</span>
      <button class="btn node-add shell" @click="addNode('shell')">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5l6 7-6 7m8 0h8"/></svg>
        Shell 执行
      </button>
      <button class="btn node-add approval" @click="addNode('approval')">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M8.5 12l2.5 2.5 4.5-4.5"/></svg>
        人工审批
      </button>
    </section>

    <!-- 触发源配置 -->
    <section class="trigger-card card rise" style="animation-delay:.09s">
      <div class="trig-head">
        <span class="mono-tag">触发源</span>
        <div class="seg-tabs">
          <button type="button" class="seg-tab" :class="{ active: triggerTab === 'manual' }" @click="triggerTab = 'manual'">Manual 参数</button>
          <button type="button" class="seg-tab" :class="{ active: triggerTab === 'webhook' }" @click="triggerTab = 'webhook'">Webhook</button>
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
    </section>

    <!-- 画布 -->
    <section class="canvas card rise" style="animation-delay:.1s">
      <div class="canvas-grd"></div>

      <div v-if="!current.spec_json.nodes.length" class="empty">
        <svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h11M14 6a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0zM3 12h11M14 12a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0zM3 18h11M14 18a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0z"/>
        </svg>
        <p class="display" style="font-size:15px;color:var(--text-2);margin:0 0 6px">画布为空</p>
        <p>从上方「添加节点」开始搭建你的第一个工作流。</p>
      </div>

      <draggable
        v-else
        v-model="nodes"
        item-key="id"
        handle=".drag-handle"
        class="node-list stagger"
        ghost-class="node-ghost"
      >
        <template #item="{ element: n, index: i }">
          <div class="node-row">
            <div class="rail">
              <div class="rail-dot" :style="{ background: NODE_KINDS[n.type].accent }"></div>
              <div class="rail-line" :class="{ fade: i === current.spec_json.nodes.length - 1 }"></div>
            </div>

            <div class="node-card" :style="{ '--node-accent': NODE_KINDS[n.type].accent }">
              <div class="node-head">
                <span class="node-ico" :style="{ color: NODE_KINDS[n.type].accent, borderColor: 'currentColor' }">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path :d="NODE_KINDS[n.type].icon" />
                  </svg>
                </span>
                <div class="node-title">
                  <span class="node-kind display">{{ NODE_KINDS[n.type].label }}</span>
                  <span class="mono-tag">{{ drainId(n.id) }}</span>
                </div>
                <span class="node-step mono">STEP {{ String(i + 1).padStart(2, "0") }}</span>
                <div class="node-head-actions">
                  <button class="btn btn-sm drag-handle" title="拖拽排序" aria-label="拖拽排序">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M9 6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm6 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM9 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm6 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM9 21a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm6 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/></svg>
                  </button>
                  <button class="btn btn-sm btn-danger" @click="current.spec_json.nodes.splice(i, 1)" aria-label="删除节点">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
                  </button>
                </div>
              </div>

              <div class="node-body">
                <template v-if="n.type === 'shell'">
                  <div class="field">
                    <label class="field-label">ECI 凭证 <span class="req">*</span></label>
                    <select class="select" v-model="n.params.credential">
                      <option value="">选择运行载体（阿里云 ECI 凭证）…</option>
                      <option v-for="c in eciCreds" :key="c.name" :value="c.name">{{ c.name }}</option>
                    </select>
                    <p class="field-hint" v-if="!eciCreds.length">暂无 ECI 凭证，请先在「凭证」中创建阿里云 ECI 类型凭证</p>
                    <p class="field-hint" v-else>Shell 节点将使用该凭证在阿里云 ECI 上创建一次性容器执行命令</p>
                  </div>
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
                    <label class="field-label">输出变量（K=V，写回供后继节点引用）</label>
                    <div class="kv-list">
                      <div v-for="(o, oi) in n.params.outputs || []" :key="oi" class="kv-row">
                        <input class="input mono kv-key" v-model="o.key" :placeholder="'step_out' + (oi ? '' : '（默认）')" />
                        <button type="button" class="btn btn-sm btn-danger" title="删除" @click="n.params.outputs.splice(oi, 1)">×</button>
                      </div>
                      <button type="button" class="btn btn-sm btn-ghost" @click="(n.params.outputs = n.params.outputs || []).push({ key: '' })">＋ 添加输出 key</button>
                    </div>
                    <p class="field-hint">脚本内可用 <code class="mono ph-code">echo "key=value" >> "$CLOUDSHUTTLE_OUT_FILE"</code> 写回；未配置 key 时默认输出单变量 <code class="mono ph-code">step_out</code>。</p>
                  </div>
                  <div class="field">
                    <label class="field-label">执行规格 / 超时（秒）</label>
                    <div class="group-row">
                      <input class="input mono" v-model="n.params.resource" placeholder="2 vCPU · 4 GiB（可选）" />
                      <input class="input mono" v-model.number="n.params.timeout" placeholder="300" />
                    </div>
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
                              v-for="c in creds"
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
                            <div v-if="!creds.length && !credsLoading" class="cs-empty">暂无机器人，点右侧刷新图标加载</div>
                          </div>
                        </div>
                        <button type="button" class="btn btn-sm btn-ghost refresh-btn" title="加载/刷新机器人" @click="loadCreds" :disabled="credsLoading">⟳</button>
                      </div>
                      <p v-if="!creds.length" class="field-hint">{{ credsLoading ? "加载中…" : "暂无机器人，点击右侧刷新图标加载" }}</p>
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
        </template>
      </draggable>
    </section>

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
.page { display: flex; flex-direction: column; gap: 18px; max-width: 1280px; width: 100%; margin: 0 auto; }
.page-head {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 16px;
  padding-bottom: 2px; flex-wrap: wrap;
}
.title-wrap { display: flex; align-items: flex-end; gap: 14px; }
.back-btn { flex: 0 0 auto; }
.head-title { margin: 0; font-size: 26px; font-weight: 700; letter-spacing: 0.01em; }
.head-sub { margin: 6px 0 0; font-size: 13.5px; }
.head-actions { display: flex; gap: 8px; align-items: center; }

.name-bar { display: flex; gap: 24px; align-items: flex-end; padding: 18px 20px; }
.name-field { flex: 1; margin-bottom: 0; }
.counter { font-size: 22px; font-weight: 600; color: var(--accent); line-height: 1; padding: 4px 0; }

.toolbox { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.node-add { display: inline-flex; }
.node-add.shell { color: var(--accent); background: var(--accent-soft); border-color: transparent; }
.node-add.shell:hover { background: rgba(84,208,198,.2); }
.node-add.approval { color: var(--ember); background: var(--warn-soft); border-color: transparent; }
.node-add.approval:hover { background: rgba(255,192,77,.22); }

.canvas { position: relative; padding: 26px 26px 30px; overflow: hidden; }
.canvas-grd {
  position: absolute; inset: 0; pointer-events: none; opacity: .7;
  background-image:
    linear-gradient(rgba(122,160,240,0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(122,160,240,0.05) 1px, transparent 1px);
  background-size: 26px 26px;
}
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
.node-head-actions { display: flex; gap: 4px; }
.drag-handle { cursor: grab; color: var(--text-3); background: transparent; border-color: transparent; }
.drag-handle:hover { color: var(--text-2); background: var(--bg-3); border-color: var(--line); }
.node-step { font-size: 10px; color: var(--text-3); letter-spacing: .1em; white-space: nowrap; }

.node-body { padding: 16px; }
.approval-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
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

/* 触发源配置区 */
.trigger-card { padding: 16px 20px; }
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