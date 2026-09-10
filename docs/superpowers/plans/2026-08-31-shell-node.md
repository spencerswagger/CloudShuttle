# CloudShuttle Shell 执行节点 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 shell 节点在 ECI 容器内经统一 runner 入口执行用户命令，脚本输出（K=V）写回扁平变量环境供后继节点引用，执行日志回传控制面供详情页展示。

**Architecture:** 后端 `runner/run.sh` 作为 ECI 统一入口：启动后从新增的 `/_/hook/job/:token` 端点拉取 job 定义（command/outputKeys/timeout/env），执行命令并把 stdout/stderr 收进日志、把脚本显式写入输出文件的 K=V 内容捕获，成功回调 `/_/hook/ecidone` 携带 `result.{output, logs}`；后端 `eciDone` 透传 result → `orchestrator.onEciDone` 用 `parseOutput` 解析输出写回 environment（对后继可见）并把 output/logs 记入 `execution_node`（新增 `logs` 列）。前端 shell 面板补齐 env/outputs/资源/超时配置，执行详情页按节点展示日志与输出。

**Tech Stack:** Node 22+（ESM，`node --test`）、PostgreSQL（`db/migrate.js` 版本化迁移）、Redis（快照）、sh + curl + jq（runner）、Vue 3 + Vite（前端）。

---

## 文件结构

- `backend/db/migrations/004_node_logs.sql` — Create：`execution_node` 增加 `logs` 列（幂等）。
- `runner/run.sh` — Modify：输出/日志分离 + 成功回调携带 `result.{output,logs}` + 失败回调带 secret。
- `backend/steps/shell.js` — Modify：向 ECI env 注入 runner 控制变量（`CLOUDSHUTTLE_JOB_URL/OUT_FILE/TOKEN/CB_SECRET/CB_BASE/EXEC_ID/NODE_ID`）。
- `backend/engine/orchestrator.js` — Modify：`onEciDone` 接收 `{output,logs}`，`parseOutput` 后写回 environment 并记录日志。
- `backend/handlers/internal.js` — Modify：`eciDone` 透传 `result.output/logs`。
- `backend/index.js` — Modify：新增 `RE.job` 三处注册（正则/routeToHandler/DISPATCH）；`buildApp` 内实现 `getJob`；`writeNodeRecord` 支持 `logs`；`getExecution` 附带节点步骤（含 output/logs）。
- `backend/handlers/api.js` — Modify：`getExecution` 组装节点步骤数组。
- `backend/test/` — Modify：`eci.test.js`、`handlers.test.js`、`orchestrator.test.js`、`webhook.test.js`、`schema.test.js` 补断言。
- `frontend/src/pages/PipelineEdit.vue` — Modify：shell 面板补 env / 输出 key / 资源 / 超时。
- `frontend/src/pages/ExecutionDetail.vue` — Modify：按节点展示日志与输出 KV。

**当前执行链路现状（改前）**：`shellStep` 派发 ECI（`createEciGroup` 目前 throw 占位）；`runner/run.sh` 拉 job 仅取 command、无 secret 回调、成功 body 为 `{ok:true}`、无 output/logs；`internal.eciDone` 已把 `body` 作为 `result` 传入但未透传；`orchestrator.onEciDone` 只记 `{kind:"eci"}`；`execution_node` 无 `logs` 列。

---

### Task 1: 迁移 —— `execution_node` 增加 `logs` 列

**Files:**
- Create: `backend/db/migrations/004_node_logs.sql`

- [ ] **Step 1: 写迁移文件**

```sql
-- 004_node_logs.sql —— execution_node 增加 logs 列，存脚本 stdout/stderr 回传内容（幂等）
ALTER TABLE execution_node ADD COLUMN IF NOT EXISTS logs TEXT;
```

- [ ] **Step 2: 本地验证迁移可重复执行**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/backend && PATH="/usr/local/bin:$PATH" node db/migrate.js`
Expected: 无报错退出；`.sql` 仅按 NNN 升序应用一次，重复运行对全新建库幂等。

- [ ] **Step 3: Commit**

```bash
git add backend/db/migrations/004_node_logs.sql
git commit -m "feat(db): execution_node 增加 logs 列存脚本输出日志"
```

---

### Task 2: `shell.js` 注入 runner 控制环境变量 + 对齐依赖注入

**Files:**
- Modify: `backend/steps/shell.js:29-46`
- Test: `backend/test/eci.test.js`

`run.sh` 需要控制面下发的完整回调契约。改造 `makeShellStep`：除了 `p.env + environment`，再把 runner 引导所需变量注入 ECI env（供 `run.sh` 读取）。

- [ ] **Step 1: 写失败的测试**

更新 `backend/test/eci.test.js` 的 skip 用例为完整断言（先跑确认当前失败）：

```js
test("shell step 派发 ECI：注入 job URL / 输出文件 / 回调 token+secret / 控制面基址", async () => {
  let dispatched = null;
  const eciProvider = { dispatch: async (arg) => { dispatched = arg; return { jobRef: "job-1" }; } };
  const registry = [];
  const step = makeShellStep({
    eciProvider,
    genToken: () => "tok-1",
    controlPlaneBase: "https://cp.example.com",
  });
  const node = { id: "n1", type: "shell", params: { image: "alpine", command: "echo hi" } };
  const ctx = { execId: 11, recordRegistry: async (r) => registry.push(r) };
  const out = await step(node, ctx);
  assert.equal(out.kind, "dispatch");
  const asMap = Object.fromEntries(dispatched.env.map((e) => [e.k, e.v]));
  assert.equal(asMap.CLOUDSHUTTLE_JOB_URL, "https://cp.example.com/_/hook/job/tok-1");
  assert.equal(asMap.CLOUDSHUTTLE_OUT_FILE, "/tmp/out");
  assert.equal(asMap.CLOUDSHUTTLE_TOKEN, "tok-1");
  assert.equal(asMap.CLOUDSHUTTLE_CB_SECRET, "tok-1");
  assert.equal(asMap.CLOUDSHUTTLE_CB_BASE, "https://cp.example.com");
  assert.equal(asMap.CLOUDSHUTTLE_EXEC_ID, "11");
  assert.equal(asMap.CLOUDSHUTTLE_NODE_ID, "n1");
  assert.equal(dispatched.callbackUrl, "https://cp.example.com/_/hook/ecidone/11?token=tok-1&secret=tok-1");
  assert.equal(registry[0].kind, "eci");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/backend && PATH="/usr/local/bin:$PATH" node --test test/eci.test.js`
Expected: FAIL（`asMap.CLOUDSHUTTLE_JOB_URL` 为 undefined）。

- [ ] **Step 3: 实现注入**

```js
export function makeShellStep({ eciProvider, genToken, controlPlaneBase }) {
  return async function shellStep(node, ctx) {
    const p = node.params;
    const base = typeof controlPlaneBase === "function" ? controlPlaneBase(ctx) : controlPlaneBase;
    const token = genToken();
    const secret = genToken(); // ECI 回调/job 同样使用独立密钥
    const jobUrl = `${base}/_/hook/job/${token}`;
    const callbackUrl = `${base}/_/hook/ecidone/${ctx.execId}?token=${token}&secret=${secret}`;
    // runner 引导变量：URL 由控制面计算，其余由 run.sh 读取；放在 env 前面（environment 同名也不可覆盖引导契约）
    const controlEnv = [
      { k: "CLOUDSHUTTLE_JOB_URL", v: jobUrl },
      { k: "CLOUDSHUTTLE_OUT_FILE", v: "/tmp/out" },
      { k: "CLOUDSHUTTLE_TOKEN", v: token },
      { k: "CLOUDSHUTTLE_CB_SECRET", v: secret },
      { k: "CLOUDSHUTTLE_CB_BASE", v: base },
      { k: "CLOUDSHUTTLE_EXEC_ID", v: String(ctx.execId) },
      { k: "CLOUDSHUTTLE_NODE_ID", v: node.id },
    ];
    // 最终 env = 引导变量 + 节点自身 p.env + environment 全部项（environment 在尾、同名覆盖优先，但不得盖过引导变量）
    const env = [...controlEnv, ...(Array.isArray(p.env) ? p.env : []), ...envToEntries(ctx.environment)];
    const { jobRef } = await eciProvider.dispatch({
      execId: ctx.execId, nodeId: node.id,
      image: p.image, command: p.command, env,
      resource: p.resource, timeout: p.timeout, callbackUrl, token,
    });
    await ctx.recordRegistry({ kind: "eci", token, secret, execId: ctx.execId, nodeId: node.id });
    return { kind: "dispatch", ref: jobRef, outputKeys: outputKeysOf(p) };
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/backend && PATH="/usr/local/bin:$PATH" node --test test/eci.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/steps/shell.js backend/test/eci.test.js
git commit -m "feat(shell): 注入 runner 引导环境变量（job URL/输出文件/回调 token+secret）"
```

---

### Task 3: `run.sh` —— 输出/日志分离与回调携带 result

**Files:**
- Modify: `runner/run.sh`

- [ ] **Step 1: 重写 run.sh**

```sh
#!/bin/sh
set -e
# 控制面下发变量：CLOUDSHUTTLE_JOB_URL, CLOUDSHUTTLE_TOKEN, CLOUDSHUTTLE_CB_SECRET,
# CLOUDSHUTTLE_CB_BASE, CLOUDSHUTTLE_EXEC_ID, CLOUDSHUTTLE_NODE_ID, CLOUDSHUTTLE_OUT_FILE
OUT_FILE="${CLOUDSHUTTLE_OUT_FILE:-/tmp/out}"
LOG_FILE="/tmp/job.log"
: > "$OUT_FILE"                       # 截断输出文件，避免残留旧值
echo "fetching job spec..."
JOB=$(curl -fsS -H "Authorization: Bearer $CLOUDSHUTTLE_TOKEN" "$CLOUDSHUTTLE_JOB_URL")
echo "$JOB" | jq -r .command > /tmp/cmd.sh
chmod +x /tmp/cmd.sh
set +e
/tmp/cmd.sh > "$LOG_FILE" 2>&1        # stdout/stderr 全部进日志；命令向 $CLOUDSHUTTLE_OUT_FILE 写 K=V 实现输出
RC=$?
set -e
LOGS=$(cat "$LOG_FILE")
OUTPUT=$(cat "$OUT_FILE")
CB_URL="${CLOUDSHUTTLE_CB_BASE}/_/hook"
if [ "$RC" -eq 0 ]; then
  curl -fsS -X POST "${CB_URL}/ecidone/${CLOUDSHUTTLE_EXEC_ID}?token=${CLOUDSHUTTLE_TOKEN}&secret=${CLOUDSHUTTLE_CB_SECRET}" \
    -H 'content-type: application/json' \
    -d "{\"result\":{\"output\":$(echo "$OUTPUT" | jq -Rs .),\"logs\":$(echo "$LOGS" | jq -Rs .)}}"
else
  curl -fsS -X POST "${CB_URL}/fail/${CLOUDSHUTTLE_EXEC_ID}?token=${CLOUDSHUTTLE_TOKEN}&secret=${CLOUDSHUTTLE_CB_SECRET}" \
    -H 'content-type: application/json' \
    -d "{\"reason\":\"exit $RC\",\"logs\":$(echo "$LOGS" | jq -Rs .)}"
fi
exit $RC
```

- [ ] **Step 2: 语法/行为检查（不依赖真实 ECI）**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/runner && sh -n run.sh && echo OK`
Expected: `OK`（`sh -n` 只做语法检查，不执行）。

- [ ] **Step 3: Commit**

```bash
git add runner/run.sh
git commit -m "feat(runner): run.sh 输出/日志分离回传 result{output,logs}，失败回调带 secret"
```

---

### Task 4: 后端 `eciDone` 透传 result + `onEciDone` 解析输出写回并记录日志

**Files:**
- Modify: `backend/engine/orchestrator.js:62-72`
- Modify: `backend/handlers/internal.js:24-29`
- Test: `backend/test/orchestrator.test.js`

- [ ] **Step 1: 写失败的回归测试（要能抓旧实现：断言回调返回前，后继节点可见写回的输出）**

在 `backend/test/orchestrator.test.js` 增加：

```js
test("eciDone：解析 K=V output 写回 environment，后继节点可见（FC 冻结下回调返回前必须完成）", async () => {
  // 构造 A(输出 src=abc) → B(引用 ${src}) 的 DAG；A 用 shell 派发等待，随后走 onEciDone
  const spec = {
    execId: 1,
    nodes: [
      { id: "a", type: "shell", params: { outputs: [{ key: "src" }], command: "echo src=abc" } },
      { id: "b", type: "approval", params: { message: "src=${src}" } },
    ],
    edges: [["a", "b"]],
  };
  let advancedEnv = null;
  const orchestrator = createOrchestrator({
    loadSpecForExec: async () => spec,
    snapshotStore: { load: async () => ({ done: [], waiting: null, environment: {} }), clear: async () => {} },
    advance: async ({ environment }) => { advancedEnv = Object.fromEntries(environment); return { status: "completed" }; },
    record: async () => {},
  });
  await orchestrator.onEciDone({ execId: 1, nodeId: "a", output: "git_sha=9f1c\nsrc=abc", logs: "# run\necho hi" });
  assert.equal(advancedEnv.src, "abc", "A 的输出 src=abc 必须写回 environment 供 B 引用");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/backend && PATH="/usr/local/bin:$PATH" node --test test/orchestrator.test.js`
Expected: FAIL（现实现 `advancedEnv.src` 为 undefined——`onEciDone` 用 `buildEnv(next.environment, null)` 丢弃输出）。

- [ ] **Step 3: 实现 onEciDone 解析输出 + 记录日志**

`backend/engine/orchestrator.js` 顶部 import 补齐，`onEciDone` 改为：

```js
import { parseOutput } from "./variables.js";
// ...
async onEciDone({ execId, nodeId, output, logs }) {
  console.log(`[orchestrator] exec=${execId} 收到 ECI 节点 ${nodeId} 成功回调，解析输出并继续推进`);
  const parsed = parseOutput(output);
  const next = await markDone(nodeId, execId, false);
  await record({ execId, nodeId, status: "succeeded", output: parsed, logs });
  const spec = await loadSpecForExec(execId);
  // 把解析出的 K=V 写回 environment（对后继节点可见），再向后继 advance
  const env = buildEnv(next.environment, parsed);
  return advance({ spec, snap: next, execId, environment: env });
},
```

`backend/handlers/internal.js` 的 `eciDone` 透传 result：

```js
export async function eciDone(orchestrator, { token, secret, result }) {
  const v = await validateCallback({ token, secret, kind: "eci" });
  if (!v.ok) return { status: 401, body: { ok: false, error: "invalid callback" } };
  // 外部副作用（解析/写库/推进）必须 await 完成后再响应，FC 容器冻结下 fire-and-forget 会丢
  await orchestrator.onEciDone({
    execId: v.execId, nodeId: v.nodeId,
    output: result?.output, logs: result?.logs,
  });
  return { status: 200, body: { ok: true } };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/backend && PATH="/usr/local/bin:$PATH" node --test test/orchestrator.test.js`
Expected: PASS。

- [ ] **Step 5: 校验 parseOutput 既有用例不被破坏**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/backend && PATH="/usr/local/bin:$PATH" node --test test/variables.test.js`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add backend/engine/orchestrator.js backend/handlers/internal.js backend/test/orchestrator.test.js
git commit -m "feat(shell): eciDone 透传输出/日志，onEciDone 解析 K=V 写回 environment 供后继引用"
```

---

### Task 5: job 拉取端点三处注册 + `getJob` 装配

**Files:**
- Modify: `backend/index.js`（RE / routeToHandler / DISPATCH / `writeNodeRecord`）
- Modify: `backend/test/handlers.test.js`
- Modify: `backend/test/webhook.test.js`

- [ ] **Step 1: 写失败的路由测试**

`backend/test/handlers.test.js` 的"外部 hook 与内部 hook 分路由"增加：

```js
assert.equal(routeToHandler("/_/hook/job/tk9", "GET", null).handler, "internal.getJob");
```

`backend/test/webhook.test.js` 双注册枚举数组增加：

```js
["/_/hook/job/tk9", "GET"],
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/backend && PATH="/usr/local/bin:$PATH" node --test test/handlers.test.js test/webhook.test.js`
Expected: FAIL（`routeToHandler` 返回 "404"）。

- [ ] **Step 3: 三处注册 + getJob 实现**

`backend/index.js` 正则区（`eciDone` 附近）新增：

```js
job: /^\/_\/hook\/job\/([^/?]+)/,
```

`routeToHandler()` 内（`RE.eciFail` 分支旁）新增：

```js
if (RE.job.test(path)) return { handler: "internal.getJob" };
```

`buildApp()` 内 `getCredentialSecrets` 之后、装配 `steps` 之前，新增 `getJob` 实现（用快照 environment 恢复变量再渲染节点参数）：

```js
async function getJob({ token }) {
  const row = await lookupRegistry({ token, kind: "eci" });
  if (!row) return { status: 401, body: { ok: false, error: "invalid token" } };
  const execId = Number(row.exec_id);
  const nodeId = row.node_id;
  const spec = await loadSpecForExec(execId);
  const node = (spec.nodes ?? []).find((n) => n.id === nodeId);
  if (!node) return { status: 404, body: { ok: false, error: "node not found" } };
  const snap = (await snapshotStore.load(execId)) ?? {};
  const env = new Map(Object.entries(snap.environment ?? {}));
  const rendered = renderParams(node.params, env);
  const envEntries = Array.isArray(rendered.env) ? rendered.env : [];
  const envFlat = [...envEntries, ...[...env].map(([k, v]) => ({ k, v: String(v) }))];
  return {
    status: 200,
    body: {
      command: rendered.command ?? "",
      timeout: rendered.timeout ?? undefined,
      outputKeys: outputKeysOf(node.params),
      env: envFlat,
    },
  };
}
```

`DISPATCH` 增加入口（job 的 token 是路径段，从 `RE.job` 捕获）：

```js
"internal.getJob": ({ app, path }) => app.getJob({ token: decodeURIComponent(m(path, RE.job)) }),
```

顶部 import 补齐 `renderParams`（engine/variables）与 `outputKeysOf`（steps/shell）：

```js
import { renderParams } from "./engine/variables.js";
import { outputKeysOf } from "./steps/shell.js";
```

`writeNodeRecord` 支持 `logs`（改签名与 SQL 一并写入 logs 列）：

```js
async function writeNodeRecord({ execId, nodeId, status, output, ref, logs }) {
  await pool.query(
    `INSERT INTO execution_node(exec_id, node_id, step, type, status, output, logs)
     VALUES($1,$2,'','',$3,$4::jsonb,$5)
     ON CONFLICT (exec_id, node_id)
     DO UPDATE SET status=EXCLUDED.status, output=EXCLUDED.output, logs=EXCLUDED.logs, finished_at=now()`,
    [execId, nodeId, status, JSON.stringify(ref ? { ref } : output ?? {}), logs ?? null]
  );
}
```

`onEciDone` 的 `record` 调用已透传 `logs`（Task 4），`stepRun` 的就地完成分支无需 logs。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/backend && PATH="/usr/local/bin:$PATH" node --test test/handlers.test.js test/webhook.test.js`
Expected: PASS（注明：`getJob` 依赖真实 pg/redis，全量 handler 冒烟只断路由双注册；DB 行为由集成环境手测）。

- [ ] **Step 5: Commit**

```bash
git add backend/index.js backend/test/handlers.test.js backend/test/webhook.test.js
git commit -m "feat(shell): 新增 /_/hook/job 拉取端点（三处注册）+ writeNodeRecord 支持 logs"
```

---

### Task 6: `getExecution` 组装节点步骤（含 output/logs）

**Files:**
- Modify: `backend/handlers/api.js:394-398`

前端详情页需要每节点日志与输出。扩展 `getExecution` 返回值：在 `execution_node` 上按 `exec_id` 聚合为 `steps`。

- [ ] **Step 1: 实现**

```js
export async function getExecution(id) {
  const { rows } = await pool.query(`SELECT * FROM execution WHERE id=$1`, [id]);
  if (!rows[0]) throw new HttpError(404, "EXECUTION_NOT_FOUND", "执行记录不存在");
  const { rows: steps } = await pool.query(
    `SELECT node_id, type, status, output, logs FROM execution_node
      WHERE exec_id=$1 ORDER BY id`,
    [id]
  );
  return { ...rows[0], steps };
}
```

- [ ] **Step 2: 全量后端测试通过（含既有执行用例不破坏）**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/backend && PATH="/usr/local/bin:$PATH" node --test`
Expected: 全 PASS。

- [ ] **Step 3: Commit**

```bash
git add backend/handlers/api.js
git commit -m "feat(exec): getExecution 附带节点步骤（含 output/logs）供详情页展示"
```

---

### Task 7: 前端 shell 节点配置增强

**Files:**
- Modify: `frontend/src/pages/PipelineEdit.vue`（shell 面板 771-804 区域）

在现有「运行镜像 + Shell 命令」下方补齐 env / 输出 key / 资源 / 超时。复用既有 `var-insert` 插入变量模式。

- [ ] **Step 1: 在 `command` 字段后追加配置块**

```vue
<div class="field">
  <label class="field-label">附加环境变量（K=V）</label>
  <div class="kv-list">
    <div v-for="(e, ei) in n.params.env || []" :key="ei" class="kv-row">
      <input class="input mono" v-model="e.k" placeholder="KEY" />
      <input class="input mono" v-model="e.v" placeholder="value（可用 ${} 引用变量）" @focus="onFieldFocus($event, n, 'env:' + ei)" />
      <button type="button" class="btn btn-sm btn-danger" title="删除" @click="n.params.env.splice(ei, 1)">×</button>
    </div>
    <button type="button" class="btn btn-sm btn-ghost" @click="(n.params.env = n.params.env || []).push({ k: '', v: '' })">＋ 添加环境变量</button>
  </div>
</div>
<div class="field">
  <label class="field-label">输出变量（K=V，写回供后继节点引用）</label>
  <div class="kv-list">
    <div v-for="(o, oi) in n.params.outputs || []" :key="oi" class="kv-row">
      <input class="input mono" v-model="o.key" :placeholder="'step_out' + (oi ? '' : '（默认）')" />
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
```

补充 `addNode('shell')` 初始化默认值（`PipelineEdit.vue:287` 附近 shell 分支）：`params: { image:'', command:'', env: [], outputs: [ { key: 'step_out' } ] }`。

- [ ] **Step 2: 构建通过**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: build 成功无错误。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/PipelineEdit.vue
git commit -m "feat(frontend): shell 节点配置补齐 env/输出 key/资源/超时"
```

---

### Task 8: 前端执行详情页展示节点日志与输出

**Files:**
- Modify: `frontend/src/pages/ExecutionDetail.vue`

- [ ] **Step 1: 模板在「执行步骤」列表下方追加每步日志/输出**

```vue
<li v-for="(s, i) in steps" :key="i" class="step">
  <span class="step-idx mono">{{ String(i + 1).padStart(2, "0") }}</span>
  <span class="step-name">{{ s.node_id || s.node?.name || s.name || `STEP ${i + 1}` }}<span class="step-type mono">{{ s.type }}</span></span>
  <span class="step-status mono">{{ s.status || "—" }}</span>
</li>
```

并在 `<ol>` 之后、`exec.log` 卡片之前追加：

```vue
<section v-if="steps.some((s) => s.logs || (typeof s.output === 'object' && s.output && Object.keys(s.output).length))" class="card steps-card rise">
  <h3 class="block-title display">节点输入 / 输出</h3>
  <div v-for="(s, i) in steps" :key="'o' + i" class="node-out">
    <template v-if="s.logs">
      <span class="step-name">{{ s.node_id }} · 日志</span>
      <pre class="log-pre mono">{{ s.logs }}</pre>
    </template>
    <template v-if="s.output && typeof s.output === 'object' && Object.keys(s.output).length">
      <span class="step-name">{{ s.node_id }} · 输出</span>
      <pre class="log-pre mono">{{ JSON.stringify(s.output, null, 2) }}</pre>
    </template>
  </div>
</section>
```

样式补 `.node-out { margin-bottom: 14px; }` 与 `.step-type { margin-left: 8px; font-size: 11px; color: var(--text-3); }`。

- [ ] **Step 2: 构建通过**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: build 成功无错误。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/ExecutionDetail.vue
git commit -m "feat(frontend): 执行详情按节点展示日志与输出 KV"
```

---

### Task 9: 后端全量回归 + 前端构建 + 契约核对

**Files:**
- None（验证 + 修复）

- [ ] **Step 1: 后端全量测试**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/backend && PATH="/usr/local/bin:$PATH" node --test`
Expected: 全 PASS。确认 `routes` 枚举含 `/ _/hook/job/tk9` 且 `isDispatched('internal.getJob')` 通过。

- [ ] **Step 2: 前端全量构建**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/frontend && PATH="/usr/local/bin:$PATH" npm run build`
Expected: 成功。

- [ ] **Step 3: 路由三处一致性人工核查（对照 AGENTS.md）**

Run: `cd /Users/fengcongyang/Downloads/serverless-pipeline/backend && grep -rn "internal.getJob" index.js && grep -rn "job:" index.js`
Expected: `internal.getJob` 在 `routeToHandler` 与 `DISPATCH` 各出现一次；`RE.job` 正则已定义。

- [ ] **Step 4: Commit（如有修复）**

```bash
git add -A
git commit -m "chore: shell 节点实现收尾回归"
```

---

## Self-Review

**Spec coverage**（对照 `2026-08-31-shell-node-design.md`）：
- 统一 runner 入口 → Task 2/3（引导 env + run.sh）。
- 新增 job 拉取端点 → Task 5（三处注册 + `getJob`）。
- 输出/日志分离回传 → Task 3（run.sh）+ Task 4（eciDone 透传 result）。
- 回调写回变量总线 → Task 4（`parseOutput` → `buildEnv(next.environment, parsed)` 向后继推进）。
- 前端配置（镜像/命令/env/资源/超时/输出 key）→ Task 7。
- 执行详情日志展示 → Task 6 + Task 8。
- 失败/超时按失败终态 → 沿用既有 `eciFail`；run.sh 失败回调已带 secret。
- 测试策略（job 鉴权/回调透传/写回 environment 回归/路由双注册）→ Task 1-6 + Task 9。
- `record` 落 `logs` 列 → Task 1 + Task 5。

**Placeholder scan**：所有步骤含完整代码或精确命令；无 TBD/TODO/"add validation"。`writeNodeRecord` 缺少的关键点已在 Task 5 给出全量签名改动。

**Type consistency**：`onEciDone` 全程统一 `{execId, nodeId, output, logs}`；`record` 统一 `{execId,nodeId,status,output,logs}`；`outputKeysOf(node.params)`（读 params.outputs，Task 2 与 Task 5 一致）；job 端点统一 `GET /_/hook/job/:token`；run.sh 变量名与 `shell.js` 注入的 `CLOUDSHUTTLE_*` 一一对应（JOB_URL/OUT_FILE/TOKEN/CB_SECRET/CB_BASE/EXEC_ID/NODE_ID）。

**注意**：`createEciGroup` 仍为占位 throw，ECI 派发在未接入真实 OpenAPI 前无法端到端运行；本计划聚焦后端路由/回调/写回链路 + runner 契约 + 前端展示，均可在无真实 ECI 下单测与构建验证。接入真实 ECI OpenAPI 属独立任务，不在此计划内。