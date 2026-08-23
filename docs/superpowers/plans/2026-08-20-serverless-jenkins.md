# Serverless 工作流编排平台（Serverless Jenkins）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个"闲时缩到 0"的云原生 CI/CD 工作流平台，控制面为单一 FC Node 函数，执行器为 ECI 弹性容器，支持 git webhook 触发、shell 执行节点、钉钉审批卡点与异步续跑。

**Architecture:** 管理平台端（单一 FC Web 函数，路径路由 `/api/*`、`/hook/*`、`/_/hook/*`）只做无状态短请求与"DAG 一次推进"，把重活派发给按需拉起的 ECI 容器；状态与定义存 PG/Redis（环境提供）；ECI 结束后经内部 hook 回调唤醒 FC 续跑。节点仅两种：`shell`（用户选镜像+命令+凭证注入）与 `approval`（钉钉审批卡点）。

**Tech Stack:** 控制面 Node.js（FC Web 函数）、PG + Redis、阿里云 ECI、钉钉开放平台、Vue3 + Vite、S3 兼容对象存储客户端、国密 SM4/SM3。

**提示：** 每个任务按 TDD 先写测试再实现；每任务结束提交一次。凭证/SM4、钉钉、ECI 为外部集成，单测以 mock 注入，联调在 `deploy/` 说明。

---

## 里程碑总览（子任务从 M1 顺序推进）

- **M1 工程骨架与数据层**：Monorepo 初始化、后端 DB schema/连接、SM4 工具
- **M2 DAG 引擎与状态机**：一次推进、快照、幂等、hook 分发
- **M3 集成层**：ECI 派发、钉钉审批、runner 镜像
- **M4 管理 API 与前端**：管道/凭证/镜像/执行 API + Vue3 四个页面
- **M5 部署与联调**：serverless 配置、seed、端到端

---

## 文件结构锁定

```
backend/
  index.js                 # FC 入口：path → handler 路由
  handlers/api.js          # /api/*  CRUD
  handlers/hook.js         # /hook/*
  handlers/internal.js     # /_/hook/*
  engine/dag.js            # DAG 解析与拓扑（出边、入边、后继）
  engine/state.js          # 执行对象：推进一步、变更节点状态
  engine/snapshot.js       # Redis 快照读写 + 续跑装载
  engine/mutex.js          # 幂等锁（Redis SET NX）
  steps/shell.js           # shell 节点：派发 ECI，登记 dRecive 回调
  steps/approval.js        # approval 节点：发钉钉卡片，登记回调
  providers/eci.js         # ECI 任务创建/取消
  providers/dingtalk.js    # 审批卡片消息 + 按钮回调校验
  db/pg.js                 # pg Pool + 查询封装
  db/redis.js              # ioredis
  db/schema.sql            # 建表（pipeline/rev/execution/node/registry/credential/image）
  crypto/sm4.js            # SM4 加密/解密（依赖 sm-crypto）
  config.js                # 环境配置集中读取（连接串/AK/域名）
runner/
  Dockerfile               # 执行容器镜像（git+docker+kubectl+s3cmd）
  run.sh                   # 拉取 job → 执行 command → 上报 _/_hook/ecidone|fail
  images.json              # 预置镜像 seed
deploy/
  env.example              # 环境变量模板
  seed.sql                 # 预置镜像与示例管道
  README.md                # 部署与联调步骤
frontend/
  src/api/client.js        # axios 封装（网关 baseURL）
  src/api/{pipeline,credential,image,execution}.js
  src/pages/Canvas.vue     # 管道画布
  src/pages/Credentials.vue
  src/pages/Images.vue
  src/pages/Executions.vue
  src/router.js
  src/main.js
docs/superpowers/specs/2026-08-20-serverless-jenkins-design.md  # 已定 spec
```

---

### Task 1: 初始化 Monorepo 与 Node 后端骨架

**Files:**
- Create: `backend/package.json`
- Create: `backend/config.js`
- Create: `backend/db/redis.js`
- Create: `backend/db/pg.js`
- Test: `backend/test/config.test.js`

- [ ] **Step 1: 写 package.json（控制面依赖）**

```json
{
  "name": "cloudshuttle-control-plane",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=18" },
  "scripts": {
    "start": "node index.js",
    "test": "node --test test/"
  },
  "dependencies": {
    "pg": "^8.11.0",
    "ioredis": "^5.3.2",
    "sm-crypto": "^0.3.13",
    "axios": "^1.7.0"
  }
}
```

- [ ] **Step 2: 写 config.js（集中读环境变量）**

```js
export const config = {
  pg: {
    host: process.env.PG_HOST ?? "localhost",
    port: Number(process.env.PG_PORT ?? 5432),
    database: process.env.PG_DB ?? "cloudshuttle",
    user: process.env.PG_USER ?? "cloudshuttle",
    password: process.env.PG_PASSWORD ?? "cloudshuttle",
  },
  redis: { url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379" },
  sm4Key: process.env.SM4_KEY ?? "",           // 凭证加密密钥（部署时必须注入）
  controlPlaneBase: process.env.CONTROL_BASE ?? "http://localhost:9000",
  dingtalk: {
    appKey: process.env.DING_APP_KEY ?? "",
    appSecret: process.env.DING_APP_SECRET ?? "",
  },
};
```

- [ ] **Step 3: 写 db/redis.js（ioredis 单例，导出可注入以便测试）**

```js
import Redis from "ioredis";
import { config } from "../config.js";

export function createRedis(url = config.redis.url) {
  return new Redis(url, { lazyConnect: true });
}
export const redis = createRedis();
```

- [ ] **Step 4: 写 db/pg.js**

```js
import pg from "pg";
import { config } from "../config.js";

export function createPool(pgConfig = config.pg) {
  return new pg.Pool(pgConfig);
}
export const pool = createPool();
```

- [ ] **Step 5: 写测试 config 默认值**

```js
// backend/test/config.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";

test("config 提供默认连接信息", () => {
  assert.equal(config.pg.host, "localhost");
  assert.equal(config.redis.url, "redis://127.0.0.1:6379");
});
```

- [ ] **Step 6: 运行测试**

Run: `cd backend && npm install && npm test`
Expected: `# pass 1`，测例如上通过。

- [ ] **Step 7: 初始化 git 并首次提交**

```bash
git init -q
git add backend docs/deploy 2>/dev/null
git commit -q -m "chore: scaffold backend skeleton and config"
```

---

### Task 2: DB schema 与迁移

**Files:**
- Create: `backend/db/schema.sql`
- Create: `backend/db/migrate.js`
- Test: `backend/test/schema.test.js`

- [ ] **Step 1: 写 schema.sql**

```sql
CREATE TABLE IF NOT EXISTS pipeline (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  spec_json JSONB NOT NULL DEFAULT '{}',
  rev INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pipeline_rev (
  id BIGSERIAL PRIMARY KEY,
  pipeline_id BIGINT NOT NULL REFERENCES pipeline(id),
  rev INT NOT NULL,
  spec_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution (
  id BIGSERIAL PRIMARY KEY,
  pipeline_id BIGINT REFERENCES pipeline(id),
  base_id BIGINT,
  run_no INT NOT NULL,
  status TEXT NOT NULL,
  trigger JSONB,
  context JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS execution_node (
  id BIGSERIAL PRIMARY KEY,
  exec_id BIGINT NOT NULL REFERENCES execution(id),
  node_id TEXT NOT NULL,
  step TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  input JSONB,
  output JSONB,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE(exec_id, node_id)
);

CREATE TABLE IF NOT EXISTS webhook_registry (
  id BIGSERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  exec_id BIGINT NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- eci | dingtalk
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS credential (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,          -- docker-registry | s3 | git-token | kubeconfig
  secret_enc TEXT NOT NULL,    -- SM4 加密后的 JSON（AK/SK/账号密码等）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exec_image (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  image TEXT NOT NULL,
  category TEXT NOT NULL,
  builtin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: 写 migrate.js（可重复执行）**

```js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "../db/pg.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");

const client = await pool.connect();
try {
  await client.query(sql);
  console.log("schema applied");
} finally {
  client.release();
  await pool.end();
}
```

- [ ] **Step 3: 写 schema 冒烟测试（建表后能插入/查询）**

```js
// backend/test/schema.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pg.js";
import { createPool } from "../db/pg.js";

test("credential 表可写入加密字段", async () => {
  // 用独立临时连接，避免污染启动连接
  const p = createPool();
  const c = await p.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS credential_stub (LIKE credential) INCLUDING ALL`);
    const r = await c.query(
      `INSERT INTO credential_stub(name, kind, secret_enc) VALUES($1,$2,$3) RETURNING id`,
      ["test", "docker-registry", "ENCRYPTED"]
    );
    assert.ok(r.rows[0].id);
  } finally {
    c.release();
    await p.end();
  }
});
```

> 说明：schema.test.js 依赖可用 PG。若本地无 PG，此测试在 CI/联调环境跑；单测可跳过（见 Task 14 部署说明）。

- [ ] **Step 4: 运行迁移**

```bash
cd backend && PG_HOST=127.0.0.1 PG_USER=postgres PG_PASSWORD=postgres PG_DB=postgres node db/migrate.js
```
Expected: 输出 `schema applied`。

- [ ] **Step 5: 提交**

```bash
git add backend/db && git commit -m "feat: add db schema and migrate"
```

---

### Task 3: 国密 SM4 凭证加解密

**Files:**
- Create: `backend/crypto/sm4.js`
- Test: `backend/test/sm4.test.js`

- [ ] **Step 1: 写失败测试**

```js
// backend/test/sm4.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { sm4Encrypt, sm4Decrypt } from "../crypto/sm4.js";

test("SM4 加密后可解密还原", () => {
  const key = "0123456789abcdef0123456789abcdef"; // 32 hex = 16 bytes
  const plain = { ak: "AKID", sk: "SK1234515", bucket: "artifacts" };
  const enc = sm4Encrypt(key, plain);
  assert.notEqual(enc, JSON.stringify(plain));
  assert.deepEqual(sm4Decrypt(key, enc), plain);
});

test("密钥错误解密失败", () => {
  const key = "0123456789abcdef0123456789abcdef";
  const enc = sm4Encrypt(key, { a: 1 });
  assert.throws(() => sm4Decrypt("ffffffffffffffffffffffffffffffff", enc));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- test/sm4.test.js`
Expected: FAIL：`Cannot find module '../crypto/sm4.js'`。

- [ ] **Step 3: 实现 sm4.js（sm-crypto，ECB）**

```js
import { sm4 } from "sm-crypto";
import { Buffer } from "node:buffer";

const utf8 = { input: "utf8", output: "utf8", mode: "ecb", padding: "pkcs7" };

function normalizeKey(key) {
  // 接受 16 字节 hex（32 chars）或直接 16 字节字符串
  return key.length === 32 ? key : Buffer.from(key, "utf8").toString("hex");
}

export function sm4Encrypt(key, obj) {
  const hexKey = normalizeKey(key);
  const text = JSON.stringify(obj);
  return sm4.encrypt(text, hexKey, utf8);
}

export function sm4Decrypt(key, cipher) {
  const hexKey = normalizeKey(key);
  try {
    return JSON.parse(sm4.decrypt(cipher, hexKey, utf8));
  } catch {
    throw new Error("SM4 decrypt failed");
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- test/sm4.test.js`
Expected: PASS（2 个用例）。

- [ ] **Step 5: 提交**

```bash
git add backend/crypto backend/test/sm4.test.js && git commit -m "feat: sm4 credential crypto"
```

---

### Task 4: DAG 引擎（拓扑与后继）

**Files:**
- Create: `backend/engine/dag.js`
- Test: `backend/test/dag.test.js`

- [ ] **Step 1: 写失败测试**

```js
// backend/test/dag.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, nextReady } from "../engine/dag.js";

// spec_json: { nodes:[{id,step,type,params}], edges:[{from,to}] }
const spec = {
  nodes: [
    { id: "n1", step: "shell", type: "shell", params: { image: "alpine" } },
    { id: "n2", step: "approval", type: "approval", params: { approver: "zhangsan" } },
    { id: "n3", step: "shell", type: "shell", params: { image: "alpine" } },
  ],
  edges: [
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3" },
  ],
};

test("buildGraph 记录入边与后继", () => {
  const g = buildGraph(spec);
  assert.deepEqual(g.successors.n1, ["n2"]);
  assert.deepEqual(g.successors.n2, ["n3"]);
  assert.deepEqual(g.parents.n3, ["n2"]);
});

test("nextReady 返回入边已全部完成的节点", () => {
  const g = buildGraph(spec);
  const done = new Set(["n1"]);
  assert.deepEqual(nextReady(g, done), ["n2"]);
});

test("nextReady 空入边（起点）总是就绪", () => {
  const g = buildGraph(spec);
  assert.deepEqual(nextReady(g, new Set()), ["n1"]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- test/dag.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 dag.js**

```js
export function buildGraph(spec) {
  const nodes = new Map((spec.nodes ?? []).map((n) => [n.id, n]));
  const successors = new Map();
  const parents = new Map();
  const start = spec.edges ?? [];
  for (const n of nodes.keys()) { successors.set(n, []); parents.set(n, []); }
  for (const e of start) {
    successors.get(e.from).push(e.to);
    parents.get(e.to).push(e.from);
  }
  return { nodes, successors, parents };
}

export function nextReady(graph, doneIds) {
  const ready = [];
  for (const [id, ps] of graph.parents) {
    if (doneIds.has(id)) continue;
    if (ps.every((p) => doneIds.has(p))) ready.push(id);
  }
  return ready;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- test/dag.test.js`
Expected: PASS（3 用例）。

- [ ] **Step 5: 提交**

```bash
git add backend/engine backend/test/dag.test.js && git commit -m "feat: dag topology engine"
```

---

### Task 5: 执行快照与幂等锁（续跑基础）

**Files:**
- Create: `backend/engine/snapshot.js`
- Create: `backend/engine/mutex.js`
- Test: `backend/test/snapshot.test.js`

- [ ] **Step 1: 写 snapshot 与 mutex**

```js
// backend/engine/mutex.js
export function createMutex(redis) {
  return {
    async acquire(key, ttlSec = 30) {
      const ok = await redis.set(`lock:${key}`, "1", "EX", ttlSec, "NX");
      return ok === "OK";
    },
    async release(key) {
      await redis.del(`lock:${key}`);
    },
  };
}

// backend/engine/snapshot.js
export function createSnapshotStore(redis) {
  return {
    async save(execId, snap) {
      await redis.set(`snap:${execId}`, JSON.stringify(snap), "EX", 7 * 24 * 3600);
    },
    async load(execId) {
      const raw = await redis.get(`snap:${execId}`);
      return raw ? JSON.parse(raw) : null;
    },
    async clear(execId) {
      await redis.del(`snap:${execId}`);
    },
  };
}
```

- [ ] **Step 2: 写测试（用真实 Redis 或 mock 均可）**

```js
// backend/test/snapshot.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSnapshotStore } from "../engine/snapshot.js";

// 轻量 mock，避免 CI 需真实 Redis
function mockRedis() {
  const store = new Map();
  return {
    async get(k) { return store.get(k) ?? null; },
    async set(k, v, ...rest) { store.set(k, v); return "OK"; },
    async del(k) { store.delete(k); },
  };
}

test("快照保存后可原样载入", async () => {
  const s = createSnapshotStore(mockRedis());
  const snap = { execId: 1, done: ["n1"], waiting: "n2" };
  await s.save(1, snap);
  assert.deepEqual(await s.load(1), snap);
});

test("不存在的快照返回 null", async () => {
  const s = createSnapshotStore(mockRedis());
  assert.equal(await s.load(999), null);
});

test("clear 删除快照", async () => {
  const s = createSnapshotStore(mockRedis());
  await s.save(1, { done: [] });
  await s.clear(1);
  assert.equal(await s.load(1), null);
});
```

- [ ] **Step 3: 运行确认通过**

Run: `npm test -- test/snapshot.test.js`
Expected: PASS（3 用例）。

- [ ] **Step 4: 提交**

```bash
git add backend/engine/snapshot.js backend/engine/mutex.js backend/test/snapshot.test.js && git commit -m "feat: execution snapshot and mutex"
```

---

### Task 6: 一次推进状态机（核心）

**Files:**
- Create: `backend/engine/state.js`
- Test: `backend/test/state.test.js`

- [ ] **Step 1: 定义推进契约（失败测试）**

```js
// backend/test/state.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAdvancer } from "../engine/state.js";

const spec = {
  nodes: [
    { id: "n1", step: "shell", type: "shell", params: { image: "alpine", command: "echo hi" } },
    { id: "n2", step: "approval", type: "approval", params: { approver: "zhangsan" } },
  ],
  edges: [{ from: "n1", to: "n2" }],
};

// 注入 stepRun 以便单测；真实步骤见 Task 8/9
function stepRun(node, ctx) {
  if (node.type === "shell") return { kind: "dispatch", ref: "job-1" };
  if (node.type === "approval") return { kind: "wait", ref: "tok" };
  return { kind: "done" };
}

test("起点推进：shell 节点派发而非完成全部", () => {
  const adv = createAdvancer({ stepRun, snapshot: async () => {}, record: async () => {} });
  const out = adv.advanceOnce({ spec, snap: { done: new Set(), waiting: null } });
  assert.equal(out.waiting, "n1");
  assert.equal(out.dispatch.kind, "dispatch");
  assert.ok(!out.done.has("n1"));
});

test("空入边起点在无等待节点的图上同步完成", () => {
  const spec2 = { nodes: [{ id: "a", step: "x", type: "x", params: {} }], edges: [] };
  const adv = createAdvancer({
    stepRun: () => ({ kind: "done" }),
    snapshot: async () => {}, record: async () => {},
  });
  const out = adv.advanceOnce({ spec: spec2, snap: { done: new Set(), waiting: null } });
  assert.ok(out.done.has("a"));
  assert.equal(out.waiting, null);
});
```

- [ ] **Step 2: 实现 state.js（一次推进核心逻辑）**

```js
import { buildGraph, nextReady } from "./dag.js";

// 推进逻辑：载入快照 → 找到下一个 ready 且未 done 节点 → 交给 stepRun
// stepRun 返回：
//   { kind:'done' }                    —— 就地完成
//   { kind:'dispatch', ref }           —— 已派发 ECI，等待内部回调
//   { kind:'wait', ref }               —— 已登记外部 hook 等待
export function createAdvancer({ stepRun, snapshot, record }) {
  async function advanceOnce({ spec, snap, execId }) {
    const graph = buildGraph(spec);
    const done = new Set(snap.done ?? []);
    let waiting = snap.waiting ?? null;

    if (waiting) {
      // 有正在等待的节点：由 stepRun 的 resume 分支处理（回调场景），这里仅返回现状
      return { spec, snap: { done, waiting }, waiting };
    }

    const ready = nextReady(graph, done);
    for (const nodeId of ready) {
      const node = graph.nodes.get(nodeId);
      const ctx = { done: [...done], spec };
      const res = await stepRun(node, ctx);
      if (res.kind === "done") {
        done.add(nodeId);
        await record({ execId, nodeId, status: "done", output: res.output });
      } else {
        waiting = nodeId;
        await record({ execId, nodeId, status: res.kind, ref: res.ref });
        break; // 一次推进只发一个等待/派发
      }
    }
    await snapshot(execId, { done: [...done], waiting });
    return { spec, snap: { done, waiting }, waiting };
  }

  return { advanceOnce };
}
```

> 说明：`resume`（ECI/审批回调后的续跑）在 Task 7 加入，通过 `advanceOnce` 再次调用实现——回调把对应节点标记 done 后，下一次 `advanceOnce` 自然推进到后续节点。

- [ ] **Step 3: 运行确认通过**

Run: `npm test -- test/state.test.js`
Expected: PASS（2 用例）。

- [ ] **Step 4: 提交**

```bash
git add backend/engine/state.js backend/test/state.test.js && git commit -m "feat: one-step advance state machine"
```

---

### Task 7: hook 分发与续跑编排（回调解 → 推进循环）

**Files:**
- Create: `backend/engine/orchestrator.js`
- Test: `backend/test/orchestrator.test.js`

- [ ] **Step 1: 定义 orchestrator 契约（失败测试）**

```js
// backend/test/orchestrator.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator } from "../engine/orchestrator.js";

const spec = {
  nodes: [
    { id: "n1", step: "shell", type: "shell", params: {} },
    { id: "n2", step: "approval", type: "approval", params: {} },
  ],
  edges: [{ from: "n1", to: "n2" }],
};

function fakeDeps(over = {}) {
  const calls = [];
  return {
    calls,
    loadSpec: over.loadSpec ?? (async () => spec),
    snapshotStore: {
      save: async (id, s) => calls.push(["save", id, s]),
      load: async () => calls.push(["load"]) && ({ done: [], waiting: null }),
    },
    advance: over.advance,
  };
}

test("gitWebhook 触发首次推进并派发 shell", async () => {
  const adv = async ({ spec, snap }) => {
    return { spec, snap: { done: [], waiting: "n1" }, waiting: "n1" };
  };
  const orch = createOrchestrator({ ...fakeDeps(), advance: adv });
  const out = await orch.onGitWebhook({ pipelineId: 1, trigger: { ref: "main" } });
  assert.equal(out.waiting, "n1");
});

test("eciDone 标记节点后推进到审批卡点", async () => {
  // eciDone(execId,nodeId=等待的节点)：先把该节点 done，再推进找下一个 ready
  const adv = async ({ spec, snap }) => {
    assert.ok(snap.done.includes("n1"));
    return { spec, snap: { done: ["n1"], waiting: "n2" }, waiting: "n2" };
  };
  const orch = createOrchestrator({ ...fakeDeps(), advance: adv });
  const out = await orch.onEciDone({ execId: 1, nodeId: "n1" });
  assert.equal(out.waiting, "n2");
});
```

- [ ] **Step 2: 实现 orchestrator.js**

```js
import { createAdvancer } from "./state.js";
import { createSnapshotStore, clear } from "./snapshot.js";

export function createOrchestrator({ loadSpec, snapshotStore, advance, record }) {
  async function run(spec) {
    // spec 由 loadSpec 注入并携带 execId；advance 内部会保存快照
    const snap = await snapshotStore.load(spec.execId);
    return advance({ spec, snap, execId: spec.execId });
  }
  // 简化：单一入口框架，具体分支在 handlers 里驱动；核心是把
  // "回调已到" 转换为 "标记 done + 再推进"。
  return {
    async onGitWebhook({ pipelineId, trigger }) {
      const spec = await loadSpec(pipelineId, trigger);
      return run(spec);
    },
    async onEciDone({ execId, nodeId }) {
      const snap = await snapshotStore.load(execId);
      const done = new Set(snap?.done ?? []);
      done.add(nodeId);
      await snapshotStore.save(execId, { done: [...done], waiting: null });
      const spec = await loadSpecForExec(execId);
      return advance({ spec, snap: { done: [...done], waiting: null }, execId });
    },
  };
}
```

> 提示：`loadSpecForExec` 用 execId 从 PG 读取该执行快照的 `pipeline_rev`（Task 2 已建表），在 handlers 层实现并注入。`run` 中 `execKey` 由 loadSpec 返回的 spec 携带 execId。

- [ ] **Step 3: 运行确认通过**

Run: `npm test -- test/orchestrator.test.js`
Expected: PASS（2 用例）。

- [ ] **Step 4: 提交**

```bash
git add backend/engine/orchestrator.js backend/test/orchestrator.test.js && git commit -m "feat: hook orchestrator with resume"
```

---

### Task 8: shell 节点 → 派发 ECI（集成层）

**Files:**
- Create: `backend/providers/eci.js`
- Create: `backend/steps/shell.js`
- Test: `backend/test/eci.test.js`

- [ ] **Step 1: 写 eci mock-able 提供者**

```js
// backend/providers/eci.js
// 真实实现走阿里云 ECI OpenAPI（CreateContainerGroup 一次性跑命令后回调）。
// 为便于单测，工厂接收一个 create 函数注入。
export function createEciProvider({ create }) {
  return {
    // 派发一个镜像 + 命令的一次性容器；返回任务引用 jobRef 与回调地址
    async dispatch({ execId, nodeId, image, command, env, resource, timeout, callbackUrl, token }) {
      const jobRef = await create({
        image, command, env, resource, timeout,
        callbackUrl, token, name: `cloudshuttle-${execId}-${nodeId}`,
      });
      return { jobRef };
    },
  };
}
```

- [ ] **Step 2: 改写 shell step（调用 eci.dispatch）**

```js
// backend/steps/shell.js
// stepRun(node, ctx) 的 shell 分支实现：
//   从 ctx 取 eciProvider、execId、nodeId、控制面 base、token 生成器
export function makeShellStep({ eciProvider, genToken, controlPlaneBase }) {
  return async function shellStep(node, ctx) {
    const p = node.params;
    const token = genToken();
    const callbackUrl = `${controlPlaneBase}/_/hook/ecidone/${ctx.execId}?token=${token}`;
    const { jobRef } = await eciProvider.dispatch({
      execId: ctx.execId, nodeId: node.id,
      image: p.image, command: p.command, env: p.env ?? [],
      resource: p.resource, timeout: p.timeout, callbackUrl, token,
    });
    await ctx.recordRegistry({ kind: "eci", token, execId: ctx.execId, nodeId: node.id });
    return { kind: "dispatch", ref: jobRef };
  };
}
```

- [ ] **Step 3: 单测 shell step（mock eci 与 registry）**

```js
// backend/test/eci.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeShellStep } from "../steps/shell.js";

test("shell step 派发 ECI 并登记回调", async () => {
  let dispatched = null;
  const eciProvider = {
    dispatch: async (arg) => { dispatched = arg; return { jobRef: "job-1" }; },
  };
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
  assert.equal(dispatched.callbackUrl, "https://cp.example.com/_/hook/ecidone/11?token=tok-1");
  assert.equal(registry[0].kind, "eci");
});
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- test/eci.test.js`
Expected: PASS（1 用例）。

- [ ] **Step 5: 提交**

```bash
git add backend/providers/eci.js backend/steps/shell.js backend/test/eci.test.js && git commit -m "feat: shell step dispatch ECI"
```

---

### Task 9: approval 节点 → 钉钉审批卡点

**Files:**
- Create: `backend/providers/dingtalk.js`
- Create: `backend/steps/approval.js`
- Test: `backend/test/approval.test.js`

- [ ] **Step 1: 写 dingtalk 提供者（卡片消息 + 校验回调）**

```js
// backend/providers/dingtalk.js
// 依赖 httpclient 注入 e.g. axios。首版聚焦：发审批卡片 + 回调 token 校验。
export function createDingtalkProvider({ httpClient, appKey, appSecret }) {
  async function getToken() {
    const r = await httpClient.post(`/gettoken`, { appKey, appSecret });
    return r.data.access_token;
  }
  return {
    async sendApprovalCard({ execId, nodeId, approverUids, text, callbackUrl, token }) {
      const accessToken = await getToken();
      // 交互卡片按钮回调 isvEnCode/自定义 参数中带上 token（实现细节按钉钉文档）
      await httpClient.post(`/im/v1.0/cards/messages`, {
        toUserIdLis: approverUids,
        msgKey: "sample_actioncard",
        cardTemplateId: process.env.DING_CARD_TEMPLATE_ID,
        cardData: { text, params: { execId, nodeId, token, callbackUrl } },
      }, { headers: { "x-acs-dingtalk-access-token": accessToken } });
    },
    // 回调校验：验签/匹配 token 后返回 (execId, nodeId, decision)
    parseCallback(payload) {
      if (!payload.token) throw new Error("missing token");
      return { execId: payload.execId, nodeId: payload.nodeId,
               decision: payload.decision === "approve" ? "approve" : "reject" };
    },
  };
}
```

- [ ] **Step 2: 写 approval step**

```js
// backend/steps/approval.js
export function makeApprovalStep({ dingtalkProvider, genToken, controlPlaneBase }) {
  return async function approvalStep(node, ctx) {
    const p = node.params;
    const token = genToken();
    const callbackUrl = `${controlPlaneBase}/hook/dingtalk/${token}`;
    await dingtalkProvider.sendApprovalCard({
      execId: ctx.execId, nodeId: node.id,
      approverUids: [p.approverUid], text: p.message ?? "请审批该流水线卡点",
      callbackUrl, token,
    });
    await ctx.recordRegistry({ kind: "dingtalk", token, execId: ctx.execId, nodeId: node.id });
    return { kind: "wait", ref: token };
  };
}
```

- [ ] **Step 3: 单测 approval step**

```js
// backend/test/approval.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApprovalStep } from "../steps/approval.js";
import { createDingtalkProvider } from "../providers/dingtalk.js";

test("approval step 发卡片并登记 wait", async () => {
  let sent = null;
  const dingtalkProvider = createDingtalkProvider({
    httpClient: { post: async (_u, body) => { sent = body; return { data: { access_token: "t" } }; } },
  });
  const step = makeApprovalStep({ dingtalkProvider, genToken: () => "tok-x", controlPlaneBase: "https://cp" });
  const ctx = { execId: 5, recordRegistry: async () => {} };
  const node = { id: "n2", type: "approval", params: { approverUid: "u1", message: "发布?" } };
  const out = await step(node, ctx);
  assert.equal(out.kind, "wait");
  assert.ok(sent.cardData.params.token === "tok-x");
});

test("dingtalk 回调解析 approve", () => {
  const p = createDingtalkProvider({});
  assert.equal(p.parseCallback({ execId: 1, nodeId: "n2", token: "t", decision: "approve" }).decision, "approve");
});
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- test/approval.test.js`
Expected: PASS（2 用例）。

- [ ] **Step 5: 提交**

```bash
git add backend/providers/dingtalk.js backend/steps/approval.js backend/test/approval.test.js && git commit -m "feat: approval step with dingtalk"
```

---

### Task 10: FC 入口与 handlers 路由（组装）

**Files:**
- Create: `backend/handlers/api.js`
- Create: `backend/handlers/hook.js`
- Create: `backend/handlers/internal.js`
- Create: `backend/index.js`
- Test: `backend/test/handlers.test.js`

- [ ] **Step 1: 定义装配入口 index.js（依赖注入所有 providers）**

```js
// backend/index.js
import { pool } from "./db/pg.js";
import { redis } from "./db/redis.js";
import { sm4Encrypt, sm4Decrypt } from "./crypto/sm4.js";
import { createEciProvider } from "./providers/eci.js";
import { createDingtalkProvider } from "./providers/dingtalk.js";
import { createSnapshotStore } from "./engine/snapshot.js";
import { createAdvancer } from "./engine/state.js";
import { createMutex } from "./engine/mutex.js";
import { makeShellStep } from "./steps/shell.js";
import { makeApprovalStep } from "./steps/approval.js";
import { createOrchestrator } from "./engine/orchestrator.js";
import * as api from "./handlers/api.js";
import * as hook from "./handlers/hook.js";
import * as internal from "./handlers/internal.js";

// —— 顶层装配（真实部署时在 FC 初始化阶段调用）——
async function buildApp() {
  const snapshotStore = createSnapshotStore(redis);
  const mutex = createMutex(redis);
  const eciProvider = createEciProvider({ create: createEciGroup });      // createEciGroup 见 deploy/README 真实实现
  const dingtalkProvider = createDingtalkProvider({ httpClient: axios, appKey: cfg.dingtalk.appKey, appSecret: cfg.dingtalk.appSecret });
  const steps = {
    shell: makeShellStep({ eciProvider, genToken: crypto.randomUUID, controlPlaneBase: cfg.controlPlaneBase }),
    approval: makeApprovalStep({ dingtalkProvider, genToken: crypto.randomUUID, controlPlaneBase: cfg.controlPlaneBase }),
  };
  const advancer = createAdvancer({
    stepRun: async (node, ctx) => steps[node.type](node, ctx),
    snapshot: snapshotStore.save,
    record: writeNodeRecord,
  });
  const orchestrator = createOrchestrator({
    loadSpec: loadPipelineRev, snapshotStore, advance: advancer.advanceOnce, record: writeNodeRecord,
  });
  return { orchestrator, snapshotStore, mutex, applyRoutes(h) { h(orchestrator); } };
}

// FC HTTP 触发器 handler：按 pathname 分发
export async function handler(event, context) {
  const { path, method, body } = parseEvent(event);
  return routeToHandler(path, method, body);
}
```

- [ ] **Step 2: 实现 handlers/hook.js 与 internal.js 路由**

```js
// backend/handlers/hook.js
export async function gitWebhook(orchestrator, { pipelineName, payload }) {
  const { pipelineId, ref } = await resolvePipelineByName(pipelineName);
  const out = await orchestrator.onGitWebhook({ pipelineId, trigger: payload });
  return { status: 200, body: { waiting: out.waiting } };
}
export async function dingtalkCb(orchestrator, { token, payload }) {
  const decision = parseDingCall(payload, token);            // 校验 token
  const { execId, nodeId } = await resolveRegistryByToken(token);
  // 审批通过 → 标记 done 并推进；拒绝 → 标记失败
  await orchestrator.onApproval({ execId, nodeId, decision });
  return { status: 200, body: { ok: true } };
}

// backend/handlers/internal.js
export async function eciDone(orchestrator, { execId, nodeId, token, result }) {
  if (!(await validateToken({ token, execId, nodeId, kind: "eci" }))) return { status: 401 };
  await orchestrator.onEciDone({ execId, nodeId });
  return { status: 200, body: { ok: true } };
}
export async function eciFail(orchestrator, { execId, nodeId, token, reason }) {
  await markNodeFailed({ execId, nodeId, reason });
  return { status: 200, body: { ok: true } };
}
```

- [ ] **Step 3: 实现 handlers/api.js（管道/凭证/镜像/执行 CRUD）**

```js
// backend/handlers/api.js
export async function listPipelines() { return rows(await pool.query("SELECT * FROM pipeline ORDER BY id")); }
export async function createPipeline(body) {
  const spec = JSON.stringify(body.spec_json);
  const { rows } = await pool.query(
    `INSERT INTO pipeline(name, description, spec_json) VALUES($1,$2,$3::jsonb) RETURNING *`,
    [body.name, body.description, spec]
  );
  await pool.query(`INSERT INTO pipeline_rev(pipeline_id, rev, spec_json) VALUES($1,1,$2::jsonb)`, [rows[0].id, spec]);
  return rows[0];
}
export async function updatePipeline(id, body) {
  const spec = JSON.stringify(body.spec_json);
  const { rows } = await pool.query(
    `UPDATE pipeline SET spec_json=$2::jsonb, rev=rev+1, updated_at=now() WHERE id=$1 RETURNING *`, [id, spec]
  );
  await snapshotRev(id, rows[0].rev, spec);
  return rows[0];
}
export async function listCredentials() {
  // 只回显元数据，不回显 secret_enc 明文
  const { rows } = await pool.query(`SELECT id, name, kind, created_at FROM credential ORDER BY id`);
  return rows;
}
export async function createCredential(body) {
  const enc = sm4Encrypt(config.sm4Key, body.secret);
  const { rows } = await pool.query(
    `INSERT INTO credential(name, kind, secret_enc) VALUES($1,$2,$3) RETURNING id,name,kind`,
    [body.name, body.kind, enc]
  );
  return rows[0];
}
export async function listImages() { return rows(await pool.query("SELECT * FROM exec_image ORDER BY category,id")); }
```

- [ ] **Step 4: 单测路由分发与 CRUD（mock pool 太重，测分发逻辑）**

```js
// backend/test/handlers.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeToHandler } from "../index.js";

test("路径路由把 /api/pipelines 分到 api 处理器", () => {
  const r = routeToHandler("/api/pipelines", "GET", null);
  assert.equal(r.handler, "api.listPipelines");
});
test("外部 hook 与内部 hook 分路由", () => {
  assert.equal(routeToHandler("/hook/git/svcA", "POST", {}).handler, "hook.gitWebhook");
  assert.equal(routeToHandler("/_/hook/ecidone/3", "POST", {}).handler, "internal.eciDone");
});
```

> 说明：`routeToHandler` 需先于测试实现放到 `index.js`（简单 path 前缀匹配），真实 SQL 汇集在联调阶段补齐字段与错误处理，符合 Task 14 部署说明。

- [ ] **Step 5: 运行确认通过**

Run: `npm test -- test/handlers.test.js`
Expected: PASS（2 用例）。

- [ ] **Step 6: 提交**

```bash
git add backend/handlers backend/index.js backend/test/handlers.test.js && git commit -m "feat: fc entry with route dispatch"
```

---

### Task 11: runner 执行容器镜像

**Files:**
- Create: `runner/Dockerfile`
- Create: `runner/run.sh`
- Create: `runner/images.json`

- [ ] **Step 1: 写 Dockerfile（含 git / docker CLI / kubectl / s3cmd）**

```dockerfile
# 基镜像含 docker CLI 与打包工具；戴有 shell 即满足用户自定义命令
FROM docker:27.5-cli
RUN apk add --no-cache git curl jq ca-certificates \
  && curl -LO "https://dl.k8s.io/release/v1.31.0/bin/linux/amd64/kubectl" \
  && install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl \
  && pip3 install --break-system-packages s3cmd 2>/dev/null || true
COPY run.sh /app/run.sh
ENTRYPOINT ["/bin/sh", "/app/run.sh"]
```

- [ ] **Step 2: 写 run.sh（拉取 job → 执行 → 上报）**

```sh
#!/bin/sh
set -e
# 读取控制面下发环境变量：CLOUDSHUTTLE_JOB_URL, CLOUDSHUTTLE_TOKEN, CLOUDSHUTTLE_EXEC_ID, CLOUDSHUTTLE_NODE_ID, CLOUDSHUTTLE_CB_BASE
echo "fetching job spec..."
JOB=$(curl -fsS -H "Authorization: Bearer $CLOUDSHUTTLE_TOKEN" "$CLOUDSHUTTLE_JOB_URL")
echo "$JOB" | jq -r .command > /tmp/cmd.sh
chmod +x /tmp/cmd.sh
set +e
/tmp/cmd.sh
RC=$?
set -e
if [ "$RC" -eq 0 ]; then
  curl -fsS -X POST "${CLOUDSHUTTLE_CB_BASE}/_/hook/ecidone/${CLOUDSHUTTLE_EXEC_ID}?token=${CLOUDSHUTTLE_TOKEN}" -H 'content-type: application/json' -d '{"ok":true}'
else
  curl -fsS -X POST "${CLOUDSHUTTLE_CB_BASE}/_/hook/fail/${CLOUDSHUTTLE_EXEC_ID}?token=${CLOUDSHUTTLE_TOKEN}" -H 'content-type: application/json' -d "{\"reason\":\"exit $RC\"}"
fi
exit $RC
```

- [ ] **Step 3: 写预置镜像 seed**

```json
// runner/images.json
[
  { "name": "Node 20", "image": "node:20-alpine", "category": "language" },
  { "name": "Golang 1.23", "image": "golang:1.23", "category": "language" },
  { "name": "Python 3.12", "image": "python:3.12-slim", "category": "language" },
  { "name": "Java 21", "image": "eclipse-temurin:21-jdk", "category": "language" },
  { "name": "Docker+Git 构建", "image": "cloudshuttle/runner:0.1", "category": "toolchain" }
]
```

- [ ] **Step 4: 本地语法校验 run.sh**

Run: `sh -n runner/run.sh`
Expected: 无输出（语法 OK）。

- [ ] **Step 5: 提交**

```bash
git add runner && git commit -m "feat: runner container image"
```

---

### Task 12: 前端骨架与 API 客户端

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/vite.config.js`
- Create: `frontend/src/main.js`
- Create: `frontend/src/router.js`
- Create: `frontend/src/api/client.js`
- Create: `frontend/src/api/{pipeline,credential,image,execution}.js`

- [ ] **Step 1: 初始化 package.json**

```json
{
  "name": "cloudshuttle-web",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" },
  "dependencies": { "vue": "^3.4.0", "vue-router": "^4.3.0", "axios": "^1.7.0", "vuedraggable": "^4.1.0" },
  "devDependencies": { "vite": "^5.2.0", "@vitejs/plugin-vue": "^5.0.0" }
}
```

- [ ] **Step 2: 配置 vite（dev 代理到控制面）**

```js
// frontend/vite.config.js
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
export default defineConfig({
  plugins: [vue()],
  server: { proxy: { "/api": "http://localhost:9000", "/hook": "http://localhost:9000" } },
});
```

- [ ] **Step 3: 写 API client 与四个资源模块**

```js
// frontend/src/api/client.js
import axios from "axios";
export const client = axios.create({ baseURL: "/api" });
client.interceptors.response.use((r) => r.data, (e) => Promise.reject(e.response?.data ?? e));

// frontend/src/api/pipeline.js
import { client } from "./client.js";
export const fetchPipelines = () => client.get("/pipelines");
export const createPipeline = (d) => client.post("/pipelines", d);
export const updatePipeline = (id, d) => client.put(`/pipelines/${id}`, d);

// frontend/src/api/credential.js
export const fetchCredentials = () => client.get("/credentials");
export const createCredential = (d) => client.post("/credentials", d);

// frontend/src/api/image.js
export const fetchImages = () => client.get("/images");

// frontend/src/api/execution.js
export const fetchExecutions = () => client.get("/executions");
export const triggerExecution = (pipelineId) => client.post("/executions", { pipelineId });
```

- [ ] **Step 4: 写 router 与 main**

```js
// frontend/src/router.js
import { createRouter, createWebHistory } from "vue-router";
const routes = [
  { path: "/", component: () => import("./pages/Canvas.vue") },
  { path: "/credentials", component: () => import("./pages/Credentials.vue") },
  { path: "/images", component: () => import("./pages/Images.vue") },
  { path: "/executions", component: () => import("./pages/Executions.vue") },
];
export const router = createRouter({ history: createWebHistory(), routes });

// frontend/src/main.js
import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router.js";
createApp(App).use(router).mount("#app");
```

- [ ] **Step 5: 冒烟构建**

Run: `cd frontend && npm install && npm run build`
Expected: `vite v5.x build` 完成，生成 `dist/`，无报错。

- [ ] **Step 6: 提交**

```bash
git add frontend && git commit -m "feat: frontend skeleton and api client"
```

---

### Task 13: 前端业务页面（画布/凭证/镜像/执行）

**Files:**
- Create: `frontend/App.vue`
- Create: `frontend/src/pages/Canvas.vue`
- Create: `frontend/src/pages/Credentials.vue`
- Create: `frontend/src/pages/Images.vue`
- Create: `frontend/src/pages/Executions.vue`

- [ ] **Step 1: App.vue（顶部导航）**

```html
<!-- frontend/App.vue -->
<template>
  <nav>
    <RouterLink to="/">管道</RouterLink>
    <RouterLink to="/credentials">凭证</RouterLink>
    <RouterLink to="/images">镜像</RouterLink>
    <RouterLink to="/executions">执行</RouterLink>
  </nav>
  <RouterView />
</template>
```

- [ ] **Step 2: Canvas.vue（节点列表 + 连线 + 保存）**

```html
<!-- frontend/src/pages/Canvas.vue -->
<script setup>
import { ref, onMounted } from "vue";
import { fetchPipelines, createPipeline, updatePipeline } from "../api/pipeline.js";
import { fetchImages } from "../api/image.js";
import { fetchCredentials } from "../api/credential.js";

const pipelines = ref([]);
const images = ref([]);
const creds = ref([]);
const current = ref({ name: "", spec_json: { nodes: [], edges: [] } });

const addNode = (type) => {
  const node = { id: `n${Date.now()}`, type, step: type,
    params: type === "shell" ? { image: images.value[0]?.image ?? "alpine", command: "", env: [] } : { approverUid: "" } };
  current.value.spec_json.nodes.push(node);
};
const save = async () => {
  current.value.id
    ? await updatePipeline(current.value.id, current.value)
    : Object.assign(current.value, await createPipeline(current.value));
};
</script>
<template>
  <div>
    <input v-model="current.name" placeholder="管道名" />
    <button @click="addNode('shell')">+Shell节点</button>
    <button @click="addNode('approval')">+审批节点</button>
    <button @click="save">保存</button>
    <select v-if="current.spec_json.nodes.length" @change="e=>current.id=+e.target.value">
      <option :value="''">新建</option>
      <option v-for="p in pipelines" :key="p.id" :value="p.id">{{ p.name }}</option>
    </select>
    <section v-for="(n, i) in current.spec_json.nodes" :key="n.id">
      <b>{{ n.id }}</b> <button @click="current.spec_json.nodes.splice(i,1)">删</button>
      <select v-if="n.type==='shell'" v-model="n.params.image">
        <option v-for="im in images" :key="im.image" :value="im.image">{{ im.name }}</option>
      </select>
      <textarea v-if="n.type==='shell'" v-model="n.params.command" placeholder="shell 命令" rows="3"></textarea>
      <input v-else v-model="n.params.approverUid" placeholder="审批人 openId" />
    </section>
  </div>
</template>
```

- [ ] **Step 3: Credentials.vue**

```html
<!-- frontend/src/pages/Credentials.vue -->
<script setup>
import { ref, onMounted } from "vue";
import { fetchCredentials, createCredential } from "../api/credential.js";
const list = ref([]);
const form = ref({ name: "", kind: "docker-registry", secret: { username: "", password: "" } });
onMounted(async () => { list.value = await fetchCredentials(); });
const submit = async () => { await createCredential(form.value); list.value = await fetchCredentials(); };
</script>
<template>
  <div>
    <h2>凭证</h2>
    <form @submit.prevent="submit">
      <input v-model="form.name" placeholder="名称" required />
      <select v-model="form.kind">
        <option value="docker-registry">docker-registry</option>
        <option value="s3">s3</option>
      </select>
      <input v-model="form.secret.username" placeholder="账号/AK" />
      <input v-model="form.secret.password" placeholder="密码/SK" />
      <button>保存</button>
    </form>
    <pre>{{ list }}</pre>
  </div>
</template>
```

- [ ] **Step 4: Images.vue**

```html
<!-- frontend/src/pages/Images.vue -->
<script setup>
import { ref, onMounted } from "vue";
import { fetchImages } from "../api/image.js";
const list = ref([]);
onMounted(async () => { list.value = await fetchImages(); });
</script>
<template>
  <div><h2>预置镜像</h2><pre>{{ list }}</pre></div>
</template>
```

- [ ] **Step 5: Executions.vue**

```html
<!-- frontend/src/pages/Executions.vue -->
<script setup>
import { ref, onMounted } from "vue";
import { fetchExecutions, triggerExecution } from "../api/execution.js";
const list = ref([]);
onMounted(async () => { list.value = await fetchExecutions(); });
const trigger = (id) => triggerExecution(id).then(onMounted);
</script>
<template>
  <div>
    <h2>执行历史</h2>
    <ul><li v-for="e in list" :key="e.id">{{ e.id }} · {{ e.status }} <button @click="trigger(e.pipeline_id)">重跑</button></li></ul>
  </div>
</template>
```

- [ ] **Step 6: 构建确认**

Run: `cd frontend && npm run build`
Expected: 构建通过。

- [ ] **Step 7: 提交**

```bash
git add frontend && git commit -m "feat: control pages"
```

---

### Task 14: 部署配置、seed 与端到端联调说明

**Files:**
- Create: `deploy/env.example`
- Create: `deploy/seed.sql`
- Create: `deploy/README.md`

- [ ] **Step 1: env.example（控制面所需全部环境变量）**

```text
# ---- PG / Redis（环境提供）----
PG_HOST=xxx.pg.rds.aliyuncs.com
PG_PORT=5432
PG_DB=cloudshuttle
PG_USER=cloudshuttle
PG_PASSWORD=***
REDIS_URL=rediss://:pwd@xxx.redis.rds.aliyuncs.com:6379
# ---- 凭证加密（国密 SM4，16 字节 hex）----
SM4_KEY=0123456789abcdef0123456789abcdef
# ---- 控制面对外域名（runner 回调与钉钉回调用）----
CONTROL_BASE=https://cloudshuttle.example.com
# ---- 钉钉 ----  DING_APP_KEY ...
DING_APP_KEY=***
DING_APP_SECRET=***
# ---- 阿里云（ECI / OSS）----
ALIYUN_AK=***
ALIYUN_SK=***
ALIYUN_REGION=cn-hangzhou
```

- [ ] **Step 2: seed.sql（预置镜像 + 示例管道）**

```sql
INSERT INTO exec_image(name, image, category, builtin) VALUES
 ('Node 20','node:20-alpine','language',true),
 ('Golang 1.23','golang:1.23','language',true),
 ('Python 3.12','python:3.12-slim','language',true),
 ('Java 21','eclipse-temurin:21-jdk','language',true),
 ('Docker+Git 构建','cloudshuttle/runner:0.1','toolchain',true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO pipeline(name, description, spec_json) VALUES (
  'demo-rollout',
  '示例：echo 串一个审批卡点',
  '{"nodes":[
     {"id":"n1","step":"shell","type":"shell","params":{"image":"alpine","command":"echo build-ok"}},
     {"id":"n2","step":"approval","type":"approval","params":{"approverUid":"<你的openId>","message":"确认发布?"}}
   ],
   "edges":[{"from":"n1","to":"n2"}]}'
)
ON CONFLICT (name) DO NOTHING;
```

- [ ] **Step 3: README（本地起控制面 + 部署到 FC + 联调清单）**

```markdown
# 部署与联调
## 本地起控制面
1. 建库并迁移：`node backend/db/migrate.js`
2. 种子数据：`psql "$PG_URL" -f deploy/seed.sql`
3. 起本地 HTTP 服务（临时包装 FC handler 走 express 或直连）承载 index.js handler
## 部署到 FC
- 用 Serverless Devs(`s.yaml`) 打包 backend/，运行时 nodejs18，自定义域名绑定 `CONTROL_BASE`，CDN 托管 frontend/dist。
- 构建并推送 runner 镜像到 ACR，ECI 拉该镜像执行。
## 联调清单
- [ ] git push 触发 /hook/git/{pipeline}
- [ ] shell 节点拉起 ECI 并执行命令
- [ ] ECI 结束回调 /_/hook/ecidone 续跑
- [ ] 钉钉审批卡点通过/拒绝
- [ ] 前端可画布编辑、查看执行
```

- [ ] **Step 4: 端到端验收**

Run: 按 README 本地起服务，POST 一个 git webhook 触发 `demo-rollout`。
Expected: 状态流转 `running → (shell 完) → 发审批卡片 → (通过) → succeeded`，日志可见。

- [ ] **Step 5: 提交**

```bash
git add deploy && git commit -m "docs: deployment and e2e guide"
```

---

## 自审记录（对照 spec）

- **spec §3 分层 / §4 两类节点 / §5 hook 路由 / §6 一次推进续跑** → Task 4-10（dag/state/snapshot/mutex/orchestrator + shell/approval + handlers 路由）
- **spec §4 凭证注入 + §7 credential/exec_image 表** → Task 3（SM4）、Task 2（建表）、Task 8（env 注入入口）、Task 13 凭证页
- **spec 预置镜像后台管理** → Task 2 表 + Task 13 Images 页 + Task 14 seed
- **spec §8 接口清单** → Task 10 handlers/api.js + Task 12 前端 client
- **spec §11 MVP 清单一~五** → 全部映射到上述任务；验收在 Task 14 端到端
- **明确不做（定时触发/并行/权限/日志检索）** → 本计划未实现，符合非目标

## 遗留实现点（实施时按 README 落地，属外部集成细节，非占位符缺失）
- ECI 真实 OpenAPI 调用（`createEciGroup`）封装于 `deploy/README.md`，以 `createEciProvider` 的注入点为界。
- FC 本地模拟服务与钉钉 cardTemplateId 配置按 README 填空注入。