<!-- frontend/src/pages/Canvas.vue -->
<script setup>
import { ref, reactive, computed, onMounted } from "vue";
import draggable from "vuedraggable";
import { fetchPipelines, createPipeline, updatePipeline, deletePipeline, runPipeline } from "../api/pipeline.js";
import { fetchImages } from "../api/image.js";
import { fetchCredentials, listDepartments, listDepartmentUsers } from "../api/credential.js";

const pipelines = ref([]);
const images = ref([]);
const creds = ref([]);
const toast = ref("");

const newPipeline = () => ({ name: "", spec_json: { nodes: [], edges: [] } });
const current = ref(newPipeline());
const nodes = computed({ get: () => current.value.spec_json.nodes, set: (v) => (current.value.spec_json.nodes = v) });

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

// 通讯录选择器：按部门树逐层加载，勾选成员填回 target.openIds
const orgOpen = ref(false);
const orgLoading = ref(false);
const orgCred = ref("");
const orgNode = ref(null);
const orgPath = ref([]);   // [{id,name}]
const orgDepts = ref([]);
const orgUsers = ref([]);
const orgSel = reactive(new Map()); // userId -> name

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
  if (!node.params.robot) { toast.value = "请先选择钉钉企业机器人"; flash(); return; }
  orgCred.value = node.params.robot;
  orgNode.value = node;
  orgPath.value = [];
  orgSel.clear();
  orgOpen.value = true;
  orgLoad();
}
function orgGoto(d) { orgPath.value.push({ id: d.id, name: d.name }); orgLoad(); }
function orgGotoIndex(i) { orgPath.value.splice(i); orgLoad(); }
function orgToggle(u) { orgSel.has(u.userId) ? orgSel.delete(u.userId) : orgSel.set(u.userId, u.name); }
function orgConfirm() {
  const node = orgNode.value;
  const ids = [...orgSel.keys()];
  const names = [...orgSel.values()];
  if (!ids.length) { toast.value = "未选择成员"; flash(); return; }
  nodeTarget(node).openIds = ids.join(",");
  nodeTarget(node).openNames = names.join("、");
  orgOpen.value = false;
  toast.value = `已选 ${ids.length} 人：${names.join("、")}`;
  flash();
}

// 保证旧节点也有 target 配置对象（惰性初始化）
const nodeTarget = (n) =>
  n.params.target ?? (n.params.target = { type: "group", openConversationId: "", openIds: "" });

const addNode = (type) => {
  const node = {
    id: `n${Date.now()}`,
    type,
    step: type,
    params:
      type === "shell"
        ? { image: images.value[0]?.image ?? "alpine", command: "", env: [] }
        : { approverUid: "", robot: "", target: { type: "group", openConversationId: "", openIds: "" } },
  };
  current.value.spec_json.nodes.push(node);
};

const loadPipeline = (ev) => {
  const id = ev.target.value;
  if (!id) { current.value = newPipeline(); return; }
  const p = pipelines.value.find((x) => x.id === +id);
  if (p) current.value = JSON.parse(JSON.stringify(p));
};

const save = async () => {
  if (!current.value.name.trim()) { toast.value = "请先填写管道名称"; flash(); return; }
  try {
    current.value.id
      ? await updatePipeline(current.value.id, current.value)
      : Object.assign(current.value, await createPipeline(current.value));
    pipelines.value = await fetchPipelines();
    toast.value = "已保存 ✓"; flash();
  } catch {
    /* 失败提示已由全局拦截器统一展示 */
  }
};

const run = async () => {
  if (!current.value.id) { toast.value = "请先保存管道"; flash(); return; }
  try {
    await runPipeline(current.value.id);
    toast.value = "已触发运行，可在执行页查看进度"; flash();
  } catch { /* 全局拦截器提示 */ }
};

const remove = async () => {
  if (!current.value.id) return;
  if (!confirm(`确定删除管道「${current.value.name}」？其全部执行历史将一并删除，不可恢复。`)) return;
  try {
    await deletePipeline(current.value.id);
    pipelines.value = await fetchPipelines();
    current.value = newPipeline();
    toast.value = "已删除"; flash();
  } catch { /* 全局拦截器提示 */ }
};

const flash = () => {
  setTimeout(() => (toast.value = ""), 2600);
};

onMounted(async () => {
  [pipelines.value, images.value, creds.value] = await Promise.all([
    fetchPipelines(), fetchImages(), fetchCredentials(),
  ]).catch(() => []);
});
</script>

<template>
  <div class="page">
    <header class="page-head rise">
      <div>
        <h1 class="head-title display">管道画布</h1>
        <p class="head-sub muted">编排 shell 执行与人工审批节点，构建可重跑的 Serverless 工作流。</p>
      </div>
      <div class="head-actions">
        <select class="select pipe-pick" :value="current.id ?? ''" @change="loadPipeline">
          <option :value="''">＋ 新建管道</option>
          <option v-for="p in pipelines" :key="p.id" :value="p.id">{{ p.name }} · #{{ String(p.id).slice(-3) }}</option>
        </select>
        <button class="btn" @click="run" :disabled="!current.id" title="立即按当前配置触发一次运行">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          运行
        </button>
        <button class="btn btn-ghost" @click="remove" :disabled="!current.id" title="删除当前管道及历史">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
          删除
        </button>
        <button class="btn btn-accent" @click="save">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8"/></svg>
          保存管道
        </button>
      </div>
    </header>

    <!-- 命名栏 -->
    <section class="name-bar card rise" style="animation-delay:.04s">
      <div class="field name-field">
        <label class="field-label">管道名称</label>
        <input class="input" v-model="current.name" placeholder="如：release-构建-发布" />
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
            <!-- 连接线 -->
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
                    <label class="field-label">运行镜像</label>
                    <select class="select" v-model="n.params.image">
                      <option v-for="im in images" :key="im.image" :value="im.image">{{ im.name }} · {{ im.image }}</option>
                    </select>
                  </div>
                  <div class="field">
                    <label class="field-label">Shell 命令</label>
                    <textarea class="textarea" v-model="n.params.command" rows="2" placeholder="echo 'hello cloudshuttle'"></textarea>
                  </div>
                </template>
                <template v-else>
                  <div class="approval-grid">
                    <div class="field">
                      <label class="field-label">钉钉机器人</label>
                      <select class="select" v-model="n.params.robot">
                        <option :value="''">请选择机器人</option>
                        <option v-for="c in creds" :key="c.id" :value="c.name">{{ c.name }}</option>
                      </select>
                    </div>
                    <div class="field">
                      <label class="field-label">审批人 openId（可选）</label>
                      <input class="input" v-model="n.params.approverUid" placeholder="用户 openId" />
                    </div>
                  </div>

                  <div v-if="isCorpRobot(n.params.robot)" class="approval-grid" style="margin-top:14px">
                    <div class="field">
                      <label class="field-label">发送目标</label>
                      <div class="kind-tabs mini">
                        <button type="button" class="kind-tab" :class="{active:(nodeTarget(n).type==='group')}" @click="nodeTarget(n).type='group'">发到群聊</button>
                        <button type="button" class="kind-tab" :class="{active:(nodeTarget(n).type==='user')}" @click="nodeTarget(n).type='user'">发给成员</button>
                      </div>
                    </div>
                    <div class="field">
                      <label class="field-label">{{ nodeTarget(n).type==='group' ? '目标群 openConversationId' : '目标成员 openId（逗号分隔）' }}</label>
                      <template v-if="nodeTarget(n).type==='group'">
                        <input class="input" v-model="nodeTarget(n).openConversationId" placeholder="群 openConversationId（创建场景群时获取）" />
                        <p class="field-hint">钉钉无“列出全部群”接口，openConversationId 需在创建场景群时保存，或经 chatId 查询获取。</p>
                      </template>
                      <template v-else>
                        <div class="group-row">
                          <input class="input" :value="nodeTarget(n).openNames || nodeTarget(n).openIds || ''" readonly placeholder="未选择（点击右侧选择成员）" />
                          <button type="button" class="btn btn-ghost" style="white-space:nowrap" @click="openOrg(n)">从通讯录选择</button>
                        </div>
                        <p v-if="nodeTarget(n).openNames" class="field-hint">已选 {{ nodeTarget(n).openIds.split(',').filter(Boolean).length }} 人 · openId：{{ nodeTarget(n).openIds }}</p>
                        <p v-else class="field-hint">点“从通讯录选择”按部门树勾选成员，自动填 openId，显示成员姓名。</p>
                      </template>
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </template>
      </draggable>
    </section>

    <!-- toast -->
    <Transition name="toast">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </Transition>

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
            <span class="org-sel">已选 {{ orgSel.size }}：{{ [...orgSel.values()].join("、") || "—" }}</span>
            <div>
              <button type="button" class="btn btn-ghost" @click="orgOpen = false">取消</button>
              <button type="button" class="btn" @click="orgConfirm">确认</button>
            </div>
          </div>
        </div>
      </div>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 18px; max-width: 880px; }

.page-head {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 16px;
  padding-bottom: 2px;
}
.head-title {
  margin: 0; font-size: 26px; font-weight: 700; letter-spacing: 0.01em;
}
.head-sub { margin: 6px 0 0; font-size: 13.5px; }
.head-actions { display: flex; gap: 8px; align-items: center; }
.pipe-pick { width: 210px; }

/* 命名栏 */
.name-bar { display: flex; gap: 24px; align-items: flex-end; padding: 18px 20px; }
.name-field { flex: 1; margin-bottom: 0; }
.counter { font-size: 22px; font-weight: 600; color: var(--accent); line-height: 1; padding: 4px 0; }

/* 工具箱 */
.toolbox { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.node-add { display: inline-flex; }
.node-add.shell { color: var(--accent); background: var(--accent-soft); border-color: transparent; }
.node-add.shell:hover { background: rgba(84,208,198,.2); }
.node-add.approval { color: var(--ember); background: var(--warn-soft); border-color: transparent; }
.node-add.approval:hover { background: rgba(255,192,77,.22); }

/* 画布 */
.canvas { position: relative; padding: 26px 26px 30px; overflow: hidden; }
.canvas-grd {
  position: absolute; inset: 0; pointer-events: none; opacity: .7;
  background-image:
    linear-gradient(rgba(122,160,240,0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(122,160,240,0.05) 1px, transparent 1px);
  background-size: 26px 26px;
}
.node-list { position: relative; display: flex; flex-direction: column; }

/* 节点行 + 连接轨道 */
.node-row { display: flex; gap: 22px; align-items: stretch; }
.rail { width: 18px; display: flex; flex-direction: column; align-items: center; padding-top: 30px; }
.rail-dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; box-shadow: 0 0 0 4px rgba(255,255,255,.05); }
.rail-line { width: 2px; flex: 1; min-height: 34px; margin-top: 4px; background: linear-gradient(var(--line-strong), var(--line)); }
.rail-line.fade { opacity: 0; }
.node-row + .node-row .rail-line { display: none; }

/* 节点卡片 */
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
.field-hint { margin-top: 6px; font-size: 12px; color: var(--text-2); line-height: 1.5; }

/* 通讯录选择器 */
.org-mask { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; }
.org-panel { width: 520px; max-width: 92vw; max-height: 80vh; background: var(--surface-2, #14181f); border: 1px solid var(--border, #2a313c); border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; }
.org-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border, #2a313c); }
.org-body { padding: 8px 16px; overflow: auto; flex: 1; min-height: 180px; }
.org-crumb { font-size: 12.5px; margin-bottom: 8px; flex-wrap: wrap; display: flex; }
.org-crumb a { color: var(--accent, #22d3ee); cursor: pointer; }
.org-slash { margin: 0 4px; color: var(--text-2, #8892a6); }
.org-depts { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
.org-dept { padding: 7px 10px; cursor: pointer; border-radius: 6px; }
.org-dept:hover { background: var(--bg-hover, #1c232d); }
.org-users { display: flex; flex-direction: column; gap: 2px; }
.org-user { display: flex; gap: 8px; align-items: center; padding: 6px 8px; cursor: pointer; border-radius: 6px; }
.org-user:hover { background: var(--bg-hover, #1c232d); }
.org-user .muted { font-size: 12px; margin-left: auto; }
.org-empty { padding: 12px 0; }
.org-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--border, #2a313c); }
.org-foot > div { display: flex; gap: 8px; }
.org-sel { font-size: 12.5px; color: var(--text-2, #8892a6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.node-ghost { opacity: .35; }

/* toast */
.toast {
  position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%);
  background: var(--bg-4); color: var(--text-1);
  border: 1px solid var(--line-strong); border-radius: 10px;
  padding: 11px 18px; font-family: var(--font-display); font-size: 13px;
  box-shadow: var(--shadow); z-index: 50;
}
</style>