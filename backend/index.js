// backend/index.js —— FC 入口（HTTP 触发器）：path → handler 路由（装配层）
// 顶层只做惰性装配（pg Pool / ioredis 均 lazyConnect，import 不崩溃）；
// 完整的 orchestrator 装配封装在 buildApp()，仅在 handler() 首次调用时惰性执行。
import { pool } from "./db/pg.js";
import { redis } from "./db/redis.js";
import { config } from "./config.js";
// `@alicloud/*` 为 CJS：ESM import 拿到 module.exports 整体，Client 类在 .default（见 providers/eci.js 注释）
import EciModule from "@alicloud/eci20180808";
const { default: EciClient, CreateContainerGroupRequest } = EciModule;
import { createEciProvider, buildCreateEciRequest, describeEciSpecs, probeEciNetworks, ECI_PRESET_CHOICES } from "./providers/eci.js";
import { createDingtalkCorpProvider } from "./providers/dingtalk-corp.js";
import { createDingtalkTokenCache } from "./providers/dingtalk-token.js";
import { createDingtalkEnroll } from "./providers/dingtalk-enroll.js";
import { createSnapshotStore } from "./engine/snapshot.js";
import { createMutex } from "./engine/mutex.js";
import { createAdvancer } from "./engine/state.js";
import { makeShellStep } from "./steps/shell.js";
import { makeApprovalStep } from "./steps/approval.js";
import { createOrchestrator } from "./engine/orchestrator.js";
import { assembleTriggerEnv } from "./engine/trigger.js";
import { randomUUID } from "node:crypto";
import axios from "axios";
import { sm4Decrypt } from "./crypto/sm4.js";
import { HttpError } from "./errors.js";
import { renderParams } from "./engine/variables.js";
import { outputKeysOf } from "./steps/shell.js";

import * as api from "./handlers/api.js";
import * as hook from "./handlers/hook.js";
import * as internal from "./handlers/internal.js";
import { isPrivateIp, clientIp } from "./security.js";

// ---------- 路径前缀匹配（纯函数，可单测） ----------
const RE = {
  pipelinesList: /^\/api\/pipelines$/,
  pipelineOne: /^\/api\/pipelines\/(\d+)$/,
  pipelineScope: /^\/api\/pipelines\/(\d+)\/scope$/,
  credentials: /^\/api\/credentials$/,
  credentialOne: /^\/api\/credentials\/(\d+)$/,
  images: /^\/api\/images$/,
  imageOne: /^\/api\/images\/(\d+)$/,
  executions: /^\/api\/executions$/,
  executionOne: /^\/api\/executions\/(\d+)$/,
  executionCancel: /^\/api\/executions\/(\d+)\/cancel$/,
  executionRerun: /^\/api\/executions\/(\d+)\/rerun$/,
  webhookSecret: /^\/api\/pipelines\/(\d+)\/webhook-secret$/,
  webhookSecretReset: /^\/api\/pipelines\/(\d+)\/webhook-secret\/reset$/,
  webhookProbe: /^\/api\/pipelines\/(\d+)\/webhook-probe$/,
  pipelineRun: /^\/api\/pipelines\/(\d+)\/run$/,
  webhookTrigger: /^\/hook\/webhook\/([^/]+)/,
  dingtalkCard: /^\/hook\/dingtalk\/card\/([^/]+)/,
  dingtalkCardFixed: /^\/hook\/dingtalk\/card\/?$/,
  dingtalk: /^\/hook\/dingtalk\/([^/]+)/,
  dingtalkGroups: /^\/api\/dingtalk\/groups$/,
  dingtalkResolve: /^\/api\/dingtalk\/resolve-mobile$/,
  dingtalkDepartments: /^\/api\/dingtalk\/departments$/,
  dingtalkDeptUsers: /^\/api\/dingtalk\/department-users$/,
  eciDone: /^\/_\/hook\/ecidone\/(\d+)/,
  eciFail: /^\/_\/hook\/fail\/(\d+)/,
  job: /^\/_\/hook\/job\/([^/?]+)/,
  eciSpecs: /^\/api\/eci\/specs$/,
  eciProbeNetworks: /^\/api\/eci\/probe-networks$/,
};

export function routeToHandler(path, method, body) {
  void body;
  const m = (method ?? "GET").toUpperCase();

  if (RE.credentials.test(path)) {
    if (m === "GET") return { handler: "api.listCredentials" };
    if (m === "POST") return { handler: "api.createCredential" };
  }
  if (RE.credentialOne.test(path)) {
    if (m === "GET") return { handler: "api.getCredential" };
    if (m === "DELETE") return { handler: "api.deleteCredential" };
    if (m === "PUT" || m === "PATCH") return { handler: "api.updateCredential" };
  }
  if (RE.images.test(path)) {
    if (m === "GET") return { handler: "api.listImages" };
    if (m === "POST") return { handler: "api.createImage" };
  }
  if (RE.imageOne.test(path)) {
    if (m === "GET") return { handler: "api.getImage" };
    if (m === "DELETE") return { handler: "api.deleteImage" };
    if (m === "PUT" || m === "PATCH") return { handler: "api.updateImage" };
  }
  if (RE.executions.test(path)) {
    if (m === "GET") return { handler: "api.listExecutions" };
    if (m === "POST") return { handler: "api.createExecution" };
  }
  if (RE.executionOne.test(path)) {
    if (m === "GET") return { handler: "api.getExecution" };
  }
  if (RE.executionCancel.test(path)) {
    if (m === "POST") return { handler: "api.cancelExecution" };
  }
  if (RE.executionRerun.test(path)) {
    if (m === "POST") return { handler: "api.rerunExecution" };
  }
  if (RE.pipelineOne.test(path)) {
    if (m === "GET") return { handler: "api.getPipeline" };
    if (m === "PUT" || m === "PATCH") return { handler: "api.updatePipeline" };
    if (m === "DELETE") return { handler: "api.deletePipeline" };
  }
  if (RE.pipelineScope.test(path)) {
    if (m === "GET") return { handler: "api.getNodeScope" };
  }
  if (RE.pipelineRun.test(path)) {
    if (m === "POST") return { handler: "api.runPipeline" };
  }
  if (RE.pipelinesList.test(path)) {
    if (m === "GET") return { handler: "api.listPipelines" };
    if (m === "POST") return { handler: "api.createPipeline" };
  }
  if (RE.webhookSecret.test(path)) {
    if (m === "GET") return { handler: "api.getWebhookSecret" };
  }
  if (RE.webhookSecretReset.test(path)) {
    if (m === "POST") return { handler: "api.resetWebhookSecret" };
  }
  if (RE.webhookProbe.test(path)) {
    if (m === "GET") return { handler: "api.getWebhookProbe" };
  }
  if (RE.webhookTrigger.test(path)) return { handler: "hook.webhook" };
  if (RE.dingtalkCard.test(path)) return { handler: "hook.dingtalkCardCb" };
  if (RE.dingtalkCardFixed.test(path)) return { handler: "hook.dingtalkCardCb" };
  if (RE.dingtalk.test(path)) return { handler: "hook.dingtalkCardCb" };
  if (RE.dingtalkGroups.test(path)) {
    if (m === "POST") return { handler: "api.dingtalkGroups" };
  }
  if (RE.dingtalkResolve.test(path)) {
    return { handler: "api.dingtalkResolveStub" };
  }
  if (RE.dingtalkDepartments.test(path)) {
    if (m === "POST") return { handler: "api.listDepartments" };
  }
  if (RE.dingtalkDeptUsers.test(path)) {
    if (m === "POST") return { handler: "api.listDepartmentUsers" };
  }
  if (RE.eciDone.test(path)) return { handler: "internal.eciDone" };
  if (RE.eciFail.test(path)) return { handler: "internal.eciFail" };
  if (RE.job.test(path)) return { handler: "internal.getJob" };
  if (RE.eciSpecs.test(path)) {
    if (m === "POST") return { handler: "api.eciSpecs" };
  }
  if (RE.eciProbeNetworks.test(path)) {
    if (m === "POST") return { handler: "api.eciProbeNetworks" };
  }
  return { handler: "404" };
}

// ---------- 执行相关的朴素实现（真实部署时用） ----------
async function openExecution({ pipelineId, trigger }) {
  const { rows: r } = await pool.query(
    `INSERT INTO execution(pipeline_id, run_no, status, trigger)
     VALUES($1, COALESCE((SELECT MAX(run_no)+1 FROM execution WHERE pipeline_id=$1),1), 'running', $2::jsonb)
     RETURNING id`,
    [pipelineId, JSON.stringify(trigger ?? {})]
  );
  return r[0];
}

// 由 pipelineId 读最新 rev 的 spec，并开一条新执行；extra.authority 会写入 spec 供回调用
async function loadPipelineRev(pipelineId, trigger, extra) {
  const { rows: r } = await pool.query(
    `SELECT spec_json FROM pipeline_rev WHERE pipeline_id=$1 ORDER BY rev DESC LIMIT 1`,
    [pipelineId]
  );
  const spec = { ...(r[0]?.spec_json ?? {}), pipelineId };
  if (extra?.authority) spec.authority = extra.authority;
  const exec = await openExecution({ pipelineId, trigger });
  return { ...spec, execId: exec.id };
}

// 回调续跑：按 execId 读其所属 pipeline 最新 rev 的 spec
async function loadSpecForExec(execId) {
  const { rows: r } = await pool.query(
    `SELECT e.pipeline_id, p.spec_json
       FROM execution e
       JOIN pipeline_rev p ON p.pipeline_id = e.pipeline_id
      WHERE e.id = $1 ORDER BY p.rev DESC LIMIT 1`,
    [execId]
  );
  return { ...(r[0]?.spec_json ?? {}), execId };
}

// 调度日志：非节点执行日志，记录流水线调度全过程（触发/推进/等待/回调/完成/失败）。
// 写失败只告警，绝不影响主流程；也向控制台输出一行便于本地开发观察。
async function schedLog(execId, message) {
  const line = `[sched] exec=${execId} ${message}`;
  console.log(line);
  try {
    await pool.query(`INSERT INTO execution_log(exec_id, message) VALUES($1,$2)`, [execId, message]);
  } catch (err) {
    console.warn(`[sched] log write failed exec=${execId}: ${err?.message ?? err}`);
  }
}

async function writeNodeRecord({ execId, nodeId, status, output, ref, logs }) {
  // 首次写入该节点时补 step/type 与 started_at；再次写入（回调终态）只更新状态/输出/结束时间
  await pool.query(
    `INSERT INTO execution_node(exec_id, node_id, step, type, status, output, logs, started_at)
     VALUES($1,$2,'','',$3,$4::jsonb,$5, now())
     ON CONFLICT (exec_id, node_id)
     DO UPDATE SET status=EXCLUDED.status, output=EXCLUDED.output, logs=EXCLUDED.logs, finished_at=now()`,
    [execId, nodeId, status, JSON.stringify(ref ? { ref } : output ?? {}), logs ?? null]
  );
}

// 由 execId + pipelineId 构造执行元信息变量 Map（globalKeysOf 的执行元信息部分：
// pipeline_id/pipeline_name/run_no/exec_id/started_at）。值统一转字符串，便于 variables.render。
async function buildInitialEnvironment({ execId, pipelineId }) {
  const [p, e] = await Promise.all([
    pool.query(`SELECT name FROM pipeline WHERE id=$1`, [pipelineId]),
    pool.query(`SELECT run_no, started_at FROM execution WHERE id=$1`, [execId]),
  ]);
  return new Map([
    ["pipeline_id", String(pipelineId ?? "")],
    ["pipeline_name", p.rows[0]?.name ?? String(pipelineId ?? "")],
    ["run_no", String(e.rows[0]?.run_no ?? "")],
    ["exec_id", String(execId ?? "")],
    ["started_at", e.rows[0]?.started_at
      ? new Date(e.rows[0].started_at).toLocaleString("zh-CN", { hour12: false })
      : ""],
  ]);
}

// 真实 ECI OpenAPI：用 eci 凭证里的 AK/SK/Region/VSwitch/安全组 创建一次性容器组，返回容器组 ID
async function createEciGroup(params) {
  const eci = params?.eci;
  if (!eci) {
    throw new Error("未为本 shell 节点选择 ECI 凭证：请先创建 eci 类型凭证并在节点上选择");
  }
  const { accessKeyId, accessKeySecret, regionId } = eci;
  if (!accessKeyId || !accessKeySecret || !regionId) {
    throw new Error("ECI 凭证缺少 accessKeyId/accessKeySecret/regionId，请检查配置");
  }
  const reqData = buildCreateEciRequest(params);
  const client = new EciClient({
    accessKeyId,
    accessKeySecret,
    regionId,
    endpoint: `eci.${regionId}.aliyuncs.com`,
  });
  const request = new CreateContainerGroupRequest(reqData);
  const resp = await client.createContainerGroup(request);
  const cgId = resp?.body?.containerGroupId;
  if (!cgId) {
    console.error(`[eci] CreateContainerGroup returned no containerGroupId: ${JSON.stringify(resp?.body ?? resp)}`);
    throw new Error("ECI 创建容器组成功但未返回容器组 ID");
  }
  return cgId;
}

// 完整装配（真实部署时在 FC 初始化阶段调用一次；本文件顶部不强制执行）
async function buildApp() {
  const snapshotStore = createSnapshotStore(redis);
  const mutex = createMutex(redis);
  const eciProvider = createEciProvider({ create: createEciGroup });
  // 凭证类型判定 + 解密（企业应用凭证用 corp provider）
  async function getCredentialKind(name) {
    const { rows } = await pool.query(`SELECT kind FROM credential WHERE name=$1`, [name]);
    return rows[0]?.kind ?? "";
  }
  async function getCredentialSecrets(name) {
    const { rows } = await pool.query(`SELECT secret_enc FROM credential WHERE name=$1`, [name]);
    if (!rows[0]) throw new Error(`credential not found: ${name}`);
    return sm4Decrypt(config.sm4Key, rows[0].secret_enc);
  }
  const dingtalkTokenCache = createDingtalkTokenCache({ httpClient: axios });
  const dingtalkCorpProvider = createDingtalkCorpProvider({
    httpClient: axios,
    getToken: async (corp) => dingtalkTokenCache(corp),
  });
  // 凭证保存时的钉钉校验 + 自动注册审批回调（routeKey 后端生成，无需用户创建）
  const dingtalkEnroll = createDingtalkEnroll({
    httpClient: axios,
    getToken: async (corp) => dingtalkTokenCache(corp),
  });
  // 回调 base：显式 CONTROL_BASE 优先，否则用触发请求的 Host 推导
  const resolveControlBase = (ctx) =>
    config.controlPlaneBase ||
    (ctx?.spec?.authority ? `http://${ctx.spec.authority}` : "http://localhost:9000");
  // 回调登记落库：每个回调(token, kind) 独立密钥，供回拨时校验
  async function recordRegistry({ kind, token, secret, credential, execId, nodeId }) {
    await pool.query(
      `INSERT INTO webhook_registry(token, exec_id, node_id, kind, secret, credential, expires_at)
       VALUES($1,$2,$3,$4,$5,$6, now() + interval '24 hours')
       ON CONFLICT (token) DO UPDATE
         SET exec_id=EXCLUDED.exec_id, node_id=EXCLUDED.node_id,
             secret=EXCLUDED.secret, credential=EXCLUDED.credential, expires_at=EXCLUDED.expires_at`,
      [token, execId, nodeId, kind, secret ?? "", credential ?? ""]
    );
  }
  // 拉取型的内部端点：run.sh 按 token 拉取本轮 job 的 command/timeout/outputKeys/env
  async function getJob({ token }) {
    const row = await internal.lookupRegistry({ token, kind: "eci" });
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
  // ECI 凭证解析：shell 节点经 params.credential 引用 eci 凭证，只返回解密的 AK/SK；
  // 地域/交换机/安全组属于 Shell 节点运行配置（params.regionId/vswitchId/securityGroupId），
  // 由 makeShellStep 在派发前与 AK/SK 合并成完整的 eci 配置。
  async function getEciConfig(name) {
    if (!name) return null;
    const kind = await getCredentialKind(name);
    if (kind !== "eci") {
      throw new Error(`凭证 "${name}" 不是 ECI 凭证（当前类型：${kind || "未找到"}）`);
    }
    const secret = await getCredentialSecrets(name);
    return {
      accessKeyId: secret.accessKeyId,
      accessKeySecret: secret.accessKeySecret,
    };
  }
  const steps = {
    shell: makeShellStep({
      eciProvider, genToken: randomUUID, controlPlaneBase: resolveControlBase,
      getEci: getEciConfig,
    }),
    approval: makeApprovalStep({
      dingtalkCorpProvider, getCredentialKind, getCredentialSecrets,
      genToken: randomUUID, controlPlaneBase: resolveControlBase,
    }),
  };
  const advancer = createAdvancer({
    stepRun: async (node, ctx) => {
      console.log(`[step] exec=${ctx.execId} node=${node.id} type=${node.type}`);
      try {
        return await steps[node.type](node, ctx);
      } catch (err) {
        console.error(`[step] ERROR exec=${ctx.execId} node=${node.id} type=${node.type} err=${err?.message ?? err}`);
        // 步骤报错：把执行与当前节点标失败，避免执行卡死在 running、以及节点状态悬空
        try {
          await schedLog(ctx.execId, `✗ 节点 ${node.id}（${node.type}）执行失败：${err?.message ?? err}`);
          await pool.query(
            `UPDATE execution SET status='failed', finished_at=now()
              WHERE id=$1 AND status IN ('queued','running')`,
            [ctx.execId]
          );
          await pool.query(
            `INSERT INTO execution_node(exec_id, node_id, step, type, status, output)
             VALUES($1,$2,$3,$4,'failed',$5::jsonb)
             ON CONFLICT (exec_id, node_id)
             DO UPDATE SET status='failed', output=EXCLUDED.output, finished_at=now()`,
            [ctx.execId, node.id, node.type, node.type, JSON.stringify({ error: err?.message ?? String(err) })]
          );
        } catch (e) {
          console.error(`[step] fail-record error: ${e?.message ?? e}`);
        }
        throw err;
      }
    },
    snapshot: snapshotStore.save,
    record: writeNodeRecord,
    recordRegistry,
    log: schedLog,
    // 所有节点完成时：把 execution 状态从 queued/running 更新为 completed，标记结束时间
    complete: async ({ execId, status }) => {
      await schedLog(execId, `✓ 全部节点已完成 → 执行标记为 ${status}`);
      const { rowCount } = await pool.query(
        `UPDATE execution SET status=$2, finished_at = CASE WHEN finished_at IS NULL THEN now() ELSE finished_at END
          WHERE id=$1 AND status IN ('queued','running')`,
        [execId, status]
      );
      console.log(
        `[complete] exec=${execId} 已把流水线运行状态更新为 ${status} ` +
        `${rowCount ? "" : "(跳过：执行不在 queued/running，可能已被置为其他终态)"}`
      );
    },
  });
  const orchestrator = createOrchestrator({
    loadSpec: loadPipelineRev,
    loadSpecForExec,
    snapshotStore,
    advance: advancer.advanceOnce,
    record: writeNodeRecord,
    schedLog,
    // 审批拒绝 / ECI 失败回调等场景：把 execution 终态落为 failed（否则一直停在 running）
    failExecution: async (execId) => {
      await pool.query(
        `UPDATE execution SET status='failed', finished_at=now()
          WHERE id=$1 AND status IN ('queued','running')`,
        [execId]
      );
    },
  });
  // 触发前装配：读取该 pipeline 最新 rev 的 spec 并开新执行（写入 execution.trigger 留痕），
  // 构造执行元信息 Map，再按组件 origin 叠写 manual/webhook 变量，返回可直接交给
  // orchestrator.run(spec, environment) 的产物。
  async function hydrateForRun({ pipelineId, kind, formValue, webhookBody, authority, rerunOf }) {
    const trigger = kind === "manual"
      ? { trigger: "manual", params: formValue ?? {} }
      : kind === "webhook" ? { trigger: "webhook", body: webhookBody ?? {} }
      : {};
    // rerun 场景：把被重跑的原执行 id 一并留痕进新执行的 trigger，标识其 provenance
    if (rerunOf != null) trigger.rerunOf = rerunOf;
    const spec = await loadPipelineRev(pipelineId, trigger, authority ? { authority } : undefined);
    await schedLog(spec.execId, `★ 触发执行（${kind}${rerunOf != null ? `，重跑自 #${rerunOf}` : ""}）`);
    const initEnv = await buildInitialEnvironment({ execId: spec.execId, pipelineId });
    const environment = assembleTriggerEnv({ spec, formValue, webhookBody, initEnv });
    return { spec, environment };
  }
  return {
    orchestrator, snapshotStore, mutex, getCredentialSecrets,
    dingtalkTokenCache, enroll: dingtalkEnroll, hydrateForRun,
    getEciConfig, getJob,
  };
}

// ---------- 分发辅助 ----------
function m(path, re) {
  return path.match(re)?.[1] ?? null;
}
// 取原始 query 参数（P0-1）：dispatch 上下文里的 path 已在 "?" 处截断（供路由精确匹配），
// query 必须从 parseEvent 保留的 rawPath 读。优先级：ctx.rawPath → 原始 FC 事件的
// rawPath/path/url（部分触发器把 query 拼在 path/url 里）→ ctx.path（已截断，取不到即 null）。
// ctx 传 FC 事件对象本身同样可用。
export function qsOf(ctx, key) {
  const s = ctx ?? {};
  const ev = s.event ?? s;
  let raw = String(s.rawPath ?? ev.rawPath ?? ev.path ?? ev.url ?? s.path ?? "");
  // 调用方直接传原始事件（未过 parseEvent）时，同样补齐独立存放的 query 字段
  if (!raw.includes("?")) raw += extraQueryOf(ev);
  const i = raw.indexOf("?");
  if (i < 0) return null;
  return new URLSearchParams(raw.slice(i + 1)).get(key) ?? null;
}
// 路径段还原（P0-2）：生成端 buildWebhookUrl 用 encodeURIComponent(name)，消费端必须解码，
// 否则中文管道名带着百分号串去 WHERE name=$1 → 永远查不到并抛错。非法编码回退原串。
export function decodePathSegment(seg) {
  if (seg == null) return seg;
  try { return decodeURIComponent(String(seg)); } catch { return String(seg); }
}
// 从请求 header 取可回拨的 host（供 CONTROL_BASE 自动推导）
function parseHost(event) {
  const h = event?.headers ?? {};
  return h["x-forwarded-host"] || h["X-Forwarded-Host"] || h.host || h.Host || null;
}
// 回拨基地址：显式 CONTROL_BASE 优先，否则由请求 Host 推导
// （保存钉钉凭证注册回调、以及生成管道 webhook 回调地址时都用它）
function resolveCallbackBase(event) {
  if (config.controlPlaneBase) return config.controlPlaneBase;
  const host = parseHost(event);
  return host ? `http://${host}` : "";
}
async function ok(promise) {
  return { status: 200, body: await promise };
}
function fcResponse(statusCode, body, requestId) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
    body: JSON.stringify(body ?? {}),
    isBase64Encoded: false,
  };
}

const DISPATCH = {
  "api.listPipelines": async () => ok(api.listPipelines()),
  "api.createPipeline": async ({ body }) => ok(api.createPipeline(body)),
  "api.updatePipeline": async ({ path, body }) => ok(api.updatePipeline(Number(m(path, RE.pipelineOne)), body)),
  "api.deletePipeline": async ({ path }) => ok(api.deletePipeline(Number(m(path, RE.pipelineOne)))),
  "api.getPipeline": async ({ path }) => ok(api.getPipeline(Number(m(path, RE.pipelineOne)))),
  "api.getNodeScope": async (ctx) => {
    const { path } = ctx;
    // node 参数在 query 里，统一走 qsOf 读原始路径（原先就地解析 event.path 的写法并入此处）
    return ok(api.getNodeScope(Number(m(path, RE.pipelineScope)), qsOf(ctx, "node")));
  },
  "api.listCredentials": async () => ok(api.listCredentials()),
  "api.createCredential": async ({ app, body, event }) =>
    ok(api.createCredential(body, { enroll: app.enroll, base: resolveCallbackBase(event) })),
  "api.deleteCredential": async ({ path }) => ok(api.deleteCredential(Number(m(path, RE.credentialOne)))),
  "api.updateCredential": async ({ app, path, body, event }) =>
    ok(api.updateCredential(Number(m(path, RE.credentialOne)), body, { enroll: app.enroll, base: resolveCallbackBase(event) })),
  "api.getCredential": async ({ path }) => ok(api.getCredential(Number(m(path, RE.credentialOne)))),
  "api.updateImage": async ({ path, body }) => ok(api.updateImage(Number(m(path, RE.imageOne)), body)),
  "api.deleteImage": async ({ path }) => ok(api.deleteImage(Number(m(path, RE.imageOne)))),
  "api.getImage": async ({ path }) => ok(api.getImage(Number(m(path, RE.imageOne)))),
  "api.listImages": async () => ok(api.listImages()),
  "api.createImage": async ({ body }) => ok(api.createImage(body)),
  "api.listExecutions": async () => ok(api.listExecutions()),
  "api.createExecution": async ({ body }) => ok(api.createExecution(body)),
  "api.getExecution": async ({ path }) => ok(api.getExecution(Number(m(path, RE.executionOne)))),
  "api.cancelExecution": async ({ path }) => ok(api.cancelExecution(Number(m(path, RE.executionCancel)))),
  "api.runPipeline": async ({ app, path, body }) => {
    const id = Number(RE.pipelineRun.exec(path)?.[1]);
    const { spec, environment } = await app.hydrateForRun({ pipelineId: id, kind: "manual", formValue: body?.params });
    const out = await app.orchestrator.run(spec, environment);
    return {
      status: 200,
      body: {
        execId: spec.execId,
        status: out?.status ?? (out?.waiting ? "running" : "completed"),
        waiting: out?.waiting ?? null,
      },
    };
  },
  "api.rerunExecution": async ({ app, path }) => {
    const id = Number(m(path, RE.executionRerun));
    // 读取原执行留痕的 trigger，恢复其触发源输入后走统一 hydrateForRun 重新装配
    const orig = await api.getExecution(id);
    const origTrigger = orig?.trigger ?? {};
    const kind = origTrigger.trigger === "webhook" ? "webhook" : "manual";
    const formValue = kind === "manual" ? origTrigger.params : undefined;
    const webhookBody = kind === "webhook" ? origTrigger.body : undefined;
    const { spec, environment } = await app.hydrateForRun({
      pipelineId: orig.pipeline_id, kind, formValue, webhookBody, rerunOf: id,
    });
    const out = await app.orchestrator.run(spec, environment);
    return {
      status: 200,
      body: {
        execId: spec.execId,
        status: out?.status ?? (out?.waiting ? "running" : "completed"),
        waiting: out?.waiting ?? null,
      },
    };
  },
  "api.getWebhookSecret": async ({ path, event }) => {
    const out = await api.getWebhookSecret(Number(m(path, RE.webhookSecret)), { base: resolveCallbackBase(event) });
    if (!out) return { status: 404, body: { ok: false, code: "NOT_FOUND", message: "管道不存在" } };
    return ok(out);
  },
  "api.resetWebhookSecret": async ({ path, event }) => {
    const out = await api.resetWebhookSecret(Number(m(path, RE.webhookSecretReset)), { base: resolveCallbackBase(event) });
    if (!out) return { status: 404, body: { ok: false, code: "NOT_FOUND", message: "管道不存在" } };
    return ok(out);
  },
  "api.getWebhookProbe": async ({ path }) => ok(api.getWebhookProbe(Number(m(path, RE.webhookProbe)))),
  "api.eciSpecs": async (ctx) => {
    const { app, body } = ctx;
    // 用 eci 凭证的 AK/SK + Shell 节点配置的地域，探测该 region 可购规格档位（含目录价）；
    // 失败时返回预设 + 可读错误供前端降级展示
    try {
      const secret = await app.getEciConfig(body?.credential);
      if (!secret) throw new Error("请先选择 ECI 凭证");
      const regionId = body?.regionId;
      if (!regionId) throw new Error("请先在 Shell 节点配置地域（Region）");
      const eci = { ...secret, regionId };
      const out = await describeEciSpecs({ eci });
      return ok({ name: body?.credential, ...out, preset: ECI_PRESET_CHOICES });
    } catch (err) {
      return {
        status: 200,
        body: { ok: false, code: "ECI_SPECS_UNAVAILABLE", message: err?.message ?? String(err), preset: ECI_PRESET_CHOICES },
      };
    }
  },
  "api.eciProbeNetworks": async ({ app, body }) => {
    try {
      // Shell 节点配置网络：凭证提供 AK/SK，地域在节点上选择；AK/SK 仅本次请求使用，不落库
      const secret = await app.getEciConfig(body?.credential);
      if (!secret) throw new Error("请先选择 ECI 凭证");
      const regionId = body?.regionId;
      if (!regionId) throw new Error("请先在 Shell 节点选择地域（Region）");
      const out = await probeEciNetworks({ ...secret, regionId });
      return ok({ ...out });
    } catch (err) {
      return {
        status: 200,
        body: { ok: false, code: "ECI_NETWORK_UNAVAILABLE", message: err?.message ?? String(err) },
      };
    }
  },
  "hook.webhook": async (ctx) => {
    const { app, path, body, event } = ctx;
    // hook.webhook 自己返回 { status, body }（200/401/503），不能再套 ok()：
    // 套了会把任何拒绝都包成 HTTP 200，第三方与本方探针语义同时失真（与 R3 的 http_status 同源）
    return hook.webhook(
      async ({ pipelineId, payload, authority }) => {
        const { spec, environment } = await app.hydrateForRun({
          pipelineId, kind: "webhook", webhookBody: payload, authority,
        });
        return app.orchestrator.run(spec, environment);
      },
      {
        // 管道名是百分号编码的路径段，先还原再查库；secret 在 query 里，从 rawPath 读
        pipelineName: decodePathSegment(m(path, RE.webhookTrigger)),
        payload: body, authority: parseHost(event),
        secret: qsOf(ctx, "secret"),
      },
    );
  },
  "hook.dingtalkCardCb": async (ctx) => {
    const { app, path, body } = ctx;
    return hook.dingtalkCardCb(app.orchestrator, {
      // 固定路由 /hook/dingtalk/card 不含 token：不能回退到 RE.dingtalk，
      // 否则会把 "card" 误当 token，导致永远 403；token 必须取自 body.outTrackId。
      token:
        m(path, RE.dingtalkCard) ||
        (RE.dingtalkCardFixed.test(path) ? null : m(path, RE.dingtalk)),
      // secret/decision 走 URL query（新版 routeKey 回调不带它们，此时为 null 属正常）
      secret: qsOf(ctx, "secret"),
      decision: qsOf(ctx, "decision"),
      body,
      lookup: internal.lookupRegistry,
      updateCard: (payload) =>
        hook.updateDeliveredCard({
          ...payload,
          getCredentialSecrets: app.getCredentialSecrets,
          getAccessToken: app.dingtalkTokenCache,
          httpClient: axios,
        }),
    });
  },
  "api.dingtalkGroups": async ({ app, body }) =>
    ok(api.listDingtalkGroups({
      credential: body?.credential,
      getCredentialSecrets: app.getCredentialSecrets,
      getAccessToken: app.dingtalkTokenCache,
      httpClient: axios,
    })),
  "api.dingtalkResolveStub": async () =>
    ok({ users: [], deprecated: true, message: "by_mobile 接口已不可用，请改用通讯录部门接口" }),
  "api.listDepartments": async ({ app, body }) =>
    ok(api.listDepartments({
      credential: body?.credential, deptId: body?.deptId,
      getCredentialSecrets: app.getCredentialSecrets,
      getAccessToken: app.dingtalkTokenCache,
      httpClient: axios,
    })),
  "api.listDepartmentUsers": async ({ app, body }) =>
    ok(api.listDepartmentUsers({
      credential: body?.credential, deptId: body?.deptId,
      getCredentialSecrets: app.getCredentialSecrets,
      getAccessToken: app.dingtalkTokenCache,
      httpClient: axios,
    })),
  "internal.eciDone": async (ctx) => {
    const { app, body } = ctx;
    // token/secret 拼在回调 URL 的 query 上，必须从 rawPath 读
    return internal.eciDone(app.orchestrator, {
      token: qsOf(ctx, "token"), secret: qsOf(ctx, "secret"), result: body,
    });
  },
  "internal.eciFail": async (ctx) => {
    const { app, body } = ctx;
    return internal.eciFail(app.orchestrator, {
      token: qsOf(ctx, "token"), secret: qsOf(ctx, "secret"), reason: body?.reason,
    });
  },
  "internal.getJob": ({ app, path }) =>
    app.getJob({ token: decodePathSegment(m(path, RE.job)) }),
};

// 供单测校验路由双注册：routeToHandler 给出的 handler 名必须在 DISPATCH 中存在，
// 否则运行期一定 404（新增端点时两处都要登记）。
export function isDispatched(name) {
  return Object.prototype.hasOwnProperty.call(DISPATCH, name);
}

// 解析 FC 事件为 { path, rawPath, method, body }。
// path 在 "?" 处截断，仅供路由正则与路径段提取使用；rawPath 保留带 query 的原值，
// query 参数一律经 qsOf(ctx, key) 从 rawPath 读（P0-1：早先只下传截断后的 path，
// 导致 webhook secret / eci 回调 token+secret / 审批回调 decision 恒为 null）。
// 部分事件形态（API 网关代理 / FC 代码包）不把 query 拼在 path 里，而是放在
// rawQueryString / queryParameters，这里一并归一回 rawPath，避免同样的 query 丢失。
export function parseEvent(event) {
  const requestPath = String(event?.path ?? event?.url ?? "/");
  const path = requestPath.split("?")[0];
  const rawPath = requestPath.includes("?") ? requestPath : `${path}${extraQueryOf(event)}`;
  const method = (event?.httpMethod ?? event?.method ?? "GET").toUpperCase();
  let body = event?.body;
  if (typeof body === "string") {
    try { body = body ? JSON.parse(body) : null; } catch { body = null; }
  }
  return { path, rawPath, method, body };
}

// 事件里独立存放的 query（path 无 "?" 时的补充来源）；返回带前导 "?" 的串或空串
function extraQueryOf(event) {
  const q = event?.rawQueryString ?? event?.queryString ?? "";
  if (typeof q === "string" && q) return `?${q.replace(/^\?/, "")}`;
  const params = event?.queryParameters ?? event?.multiValueQueryStringParameters;
  if (params && typeof params === "object") {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      for (const one of Array.isArray(v) ? v : [v]) {
        if (one != null) usp.append(k, String(one));
      }
    }
    const s = usp.toString();
    if (s) return `?${s}`;
  }
  return "";
}

let appPromise = null;
async function getApp() {
  appPromise ??= buildApp();
  return appPromise;
}

// ---------- FC HTTP 触发器入口 ----------
export async function handler(event) {
  const requestId = randomUUID();
  const { path, rawPath, method, body } = parseEvent(event);
  const startedAt = Date.now();
  const finish = (status, out, warn = false) => {
    const ms = Date.now() - startedAt;
    const line = `[${requestId}] ${method} ${path} -> ${status} (${ms}ms)`;
    if (warn) console.warn(line);
    else console.log(line);
    return fcResponse(status, out, requestId);
  };
  try {
    const { handler: name } = routeToHandler(path, method, body);
    // /_/ 内部回调仅允许内网来源
    if (path.startsWith("/_/")) {
      const ip = clientIp(event);
      if (!isPrivateIp(ip)) {
        return finish(403, { ok: false, code: "FORBIDDEN", message: "内部接口仅允许内网访问", requestId }, true);
      }
    }
    const job = DISPATCH[name];
    if (!job) {
      return finish(404, { ok: false, code: "NOT_FOUND", message: "请求的接口不存在", requestId }, true);
    }
    const app = await getApp();
    // rawPath 一并下传：dispatch 里凡读 query 都经 qsOf(ctx, key) 取原始路径
    const { status, body: out } = await job({ app, path, rawPath, method, body, event });
    return finish(status, out);
  } catch (err) {
    const reason = `[${requestId}] ${method} ${path} FAILED: ` + (err?.detail ? `${err.detail} | ` : "") + (err?.stack || err);
    console.error(reason);
    if (err instanceof HttpError) {
      return finish(err.status, { ok: false, code: err.code, message: err.message, requestId }, true);
    }
    return finish(500, { ok: false, code: "INTERNAL_ERROR", message: "服务暂时不可用，请稍后再试", requestId }, true);
  }
}