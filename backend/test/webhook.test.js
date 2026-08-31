// backend/test/webhook.test.js —— webhook 触发链路的纯逻辑与关键行为
// 覆盖：
//   R1 query 透传（parseEvent 保留 rawPath + qsOf，P0-1：secret/token/decision 不再恒 null）
//   R2 管道名还原（decodePathSegment，P0-2：中文名地址不再 500）
//   URL 后端生成（buildWebhookUrl）
//   R3 调试探针（probeBodyJson / probeStatement / recordProbe / webhook 记录时机与 http_status，P1-3）
//   R4+R5 改名生效与返显去敏（PIPELINE_COLUMNS 与 create/update 实际 SQL，P1-1/P1-2）
//   以及 routeToHandler 与 DISPATCH 的双注册一致性。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWebhookUrl, createPipeline, updatePipeline, listPipelines, getPipeline, PIPELINE_COLUMNS,
} from "../handlers/api.js";
import {
  webhook, dingtalkCardCb, recordProbe, probeStatement, probeBodyJson,
} from "../handlers/hook.js";
import { pool } from "../db/pg.js";
import { routeToHandler, isDispatched, parseEvent, qsOf, decodePathSegment } from "../index.js";

// RE.webhookTrigger 的同形正则（测试侧不复用内部常量，显式写出以固化路径契约）
const RE_TRIGGER = /^\/hook\/webhook\/([^/]+)/;

// ---------- 生成端：回调地址 ----------
test("buildWebhookUrl 用 base 拼出完整回调地址并对 name 做编码", () => {
  const url = buildWebhookUrl({ base: "http://localhost:9000", name: "demo rollout", secret: "uuid-1" });
  assert.equal(url, "http://localhost:9000/hook/webhook/demo%20rollout?secret=uuid-1");
});

test("buildWebhookUrl 去掉 base 结尾斜杠，避免双斜杠", () => {
  assert.equal(
    buildWebhookUrl({ base: "https://ctl.example.com/", name: "svcA", secret: "s" }),
    "https://ctl.example.com/hook/webhook/svcA?secret=s"
  );
});

test("buildWebhookUrl 在 base 缺失时退化为站点相对路径（前端可补 origin）", () => {
  assert.equal(buildWebhookUrl({ name: "svcA", secret: "s" }), "/hook/webhook/svcA?secret=s");
  // name/secret 缺失时按空串处理，不写出字面量 "undefined"
  assert.equal(buildWebhookUrl({ base: "", name: undefined, secret: undefined }), "/hook/webhook/?secret=");
});

// ---------- R1：query 必须透到 handler ----------
test("R1 parseEvent 保留带 query 的 rawPath，path 截断后供路由精确匹配", () => {
  const e = parseEvent({ path: "/hook/webhook/svcA?secret=s3cret", httpMethod: "post", body: '{"ref":"main"}' });
  assert.equal(e.path, "/hook/webhook/svcA");
  assert.equal(e.rawPath, "/hook/webhook/svcA?secret=s3cret");
  assert.equal(e.method, "POST");
  assert.deepEqual(e.body, { ref: "main" });
  assert.equal(routeToHandler(e.path, e.method, e.body).handler, "hook.webhook");
});

test("R1 qsOf 取 query：优先 rawPath，回退原始事件的 path/url；无 query 时为 null", () => {
  assert.equal(qsOf({ rawPath: "/hook/webhook/x?secret=s3cret" }, "secret"), "s3cret");
  // rawPath 优先于 event.path（两者不同时以 rawPath 为准）
  assert.equal(qsOf({ rawPath: "/x?a=1", event: { path: "/x?a=2" } }, "a"), "1");
  // 没有 rawPath（直接拿 FC 事件）时，回退读事件自身的 path/url
  assert.equal(qsOf({ event: { url: "/api/pipelines/9/scope?node=n2" } }, "node"), "n2");
  assert.equal(qsOf({ path: "/api/pipelines/9/scope?node=n3" }, "node"), "n3");
  assert.equal(qsOf({ rawPath: "/hook/webhook/x" }, "secret"), null);
  assert.equal(qsOf({}, "secret"), null);
  assert.equal(qsOf(null, "secret"), null);
});

test("R1 反证：只读路由用的截断 path 取不到 query（旧实现恒 null 的根因）", () => {
  const e = parseEvent({ path: "/hook/webhook/svcA?secret=s3cret" });
  assert.equal(qsOf({ rawPath: e.path }, "secret"), null);
});

test("R1 端到端装配：?secret= 经 parseEvent+qsOf 透到 hook.webhook 入参并通过校验", async () => {
  const event = { path: "/hook/webhook/svcA?secret=s3cret", httpMethod: "POST", body: '{"ref":"refs/heads/main"}' };
  const ctx = { ...parseEvent(event), event };
  const runs = [];
  const out = await webhook(
    async (arg) => { runs.push(arg); return { waiting: "n1" }; },
    {
      pipelineName: decodePathSegment(ctx.path.match(RE_TRIGGER)[1]),
      payload: ctx.body,
      authority: "ctl.example",
      secret: qsOf(ctx, "secret"),
      resolve: async (name) => {
        assert.equal(name, "svcA", "管道名应与路径段一致");
        return { pipelineId: 42, webhookSecret: "s3cret" };
      },
      probe: async () => {},
    }
  );
  assert.equal(out.status, 200, "secret 透达后应通过密钥校验（旧实现恒 null → 401）");
  assert.deepEqual(runs, [{ pipelineId: 42, payload: { ref: "refs/heads/main" }, authority: "ctl.example" }]);
});

test("R1 内部回调同理：/_/hook/ecidone 的 token+secret 能读出（旧实现恒 null → 401）", () => {
  const event = { path: "/_/hook/ecidone/12?token=tk&secret=sk", httpMethod: "POST" };
  const ctx = { ...parseEvent(event), event };
  assert.equal(routeToHandler(ctx.path, ctx.method, ctx.body).handler, "internal.eciDone");
  assert.equal(qsOf(ctx, "token"), "tk");
  assert.equal(qsOf(ctx, "secret"), "sk");
});

test("R1 query 单独存放的事件形态（rawQueryString / queryParameters）同样归一出 query", () => {
  const byRaw = parseEvent({ path: "/hook/webhook/svcA", rawQueryString: "secret=s3cret" });
  assert.equal(byRaw.path, "/hook/webhook/svcA");
  assert.equal(byRaw.rawPath, "/hook/webhook/svcA?secret=s3cret");
  const byParams = parseEvent({ path: "/hook/webhook/svcA", queryParameters: { secret: "s3cret" } });
  assert.equal(qsOf({ ...byParams, event: byParams }, "secret"), "s3cret");
  // 直接传原始事件（未过 parseEvent）也可用
  assert.equal(qsOf({ path: "/x", multiValueQueryStringParameters: { decision: ["reject"] } }, "decision"), "reject");
  // path 自带 query 时不再拼接事件字段（避免重复 ?）
  assert.equal(parseEvent({ path: "/x?a=1", queryParameters: { a: "2" } }).rawPath, "/x?a=1");
});

test("R1 审批回调同理：secret+decision 从 query 读出并推进到 REJECT 分支", async () => {
  const event = { path: "/hook/dingtalk/tk1?secret=sk&decision=reject", httpMethod: "GET" };
  const ctx = { ...parseEvent(event), event };
  assert.equal(routeToHandler(ctx.path, ctx.method, ctx.body).handler, "hook.dingtalkCardCb");
  const approvals = [];
  const out = await dingtalkCardCb(
    { onApproval: async (arg) => { approvals.push(arg); return { status: "completed" }; } },
    {
      token: ctx.path.match(/^\/hook\/dingtalk\/([^/]+)$/)[1],
      secret: qsOf(ctx, "secret"),
      decision: qsOf(ctx, "decision"),
      body: {},
      lookup: async () => ({ exec_id: 8, node_id: "n1", credential: "", secret: "sk" }),
      updateCard: async () => {},
    }
  );
  assert.equal(out.status, 200);
  assert.deepEqual(approvals, [{ execId: 8, nodeId: "n1", decision: "reject" }]);
});

// ---------- R2：百分号编码的管道名必须还原 ----------
test("R2 中文管道名解码后才是查库用的 name", () => {
  const seg = "/hook/webhook/%E5%8F%91%E5%B8%83".match(RE_TRIGGER)[1];
  assert.equal(seg, "%E5%8F%91%E5%B8%83", "路由提取到的仍是百分号串");
  assert.equal(decodePathSegment(seg), "发布");
  assert.equal(routeToHandler("/hook/webhook/%E5%8F%91%E5%B8%83", "POST", {}).handler, "hook.webhook");
});

test("R2 空格/斜杠等编码名同样还原，普通名保持原样", () => {
  assert.equal(decodePathSegment("demo%20rollout"), "demo rollout");
  assert.equal(decodePathSegment("svcA"), "svcA");
  assert.equal(decodePathSegment(null), null);
  assert.equal(decodePathSegment(undefined), undefined);
});

test("R2 非法编码回退原串，不抛（不能让探针/触发链路因解码崩溃）", () => {
  assert.equal(decodePathSegment("%E5%8F"), "%E5%8F");
  assert.equal(decodePathSegment("%"), "%");
});

// ---------- R3：探针带处理结果 ----------
test("R3 probeBodyJson 缺省与不可序列化归一（空对象 / 占位对象）", () => {
  assert.equal(probeBodyJson(undefined), "{}");
  assert.equal(probeBodyJson(null), "{}");
  assert.equal(probeBodyJson(() => 1), "{}", "函数被 JSON.stringify 吞成 undefined，回退空对象");
  const circular = {};
  circular.self = circular;
  assert.deepEqual(JSON.parse(probeBodyJson(circular)), { _unserializable: true });
});

test("R3 probeBodyJson 256KB 以内原样序列化，超限存前 100KB 预览", () => {
  const small = { ref: "main", data: "y".repeat(200 * 1024) };
  assert.deepEqual(JSON.parse(probeBodyJson(small)), small);

  const big = { ref: "main", data: "x".repeat(300 * 1024) };
  const json = probeBodyJson(big);
  const out = JSON.parse(json);
  assert.equal(out._truncated, true);
  assert.equal(out.preview.length, 100 * 1024, "预览取原文前 100KB");
  assert.ok(Buffer.byteLength(json, "utf8") <= 256 * 1024, "截断后落库字符串本身必须可控");
  assert.ok(out.preview.startsWith('{"ref":"main"'), "预览是序列化原文的前缀");
});

test("R3 probeStatement 一次性 UPSERT body + http_status", () => {
  const { sql, params } = probeStatement(7, { ref: "refs/heads/main" }, 401);
  assert.match(sql, /INSERT INTO webhook_probe\(pipeline_id, body, http_status\) VALUES\(\$1,\$2::jsonb,\$3\)/);
  assert.match(
    sql,
    /ON CONFLICT \(pipeline_id\) DO UPDATE SET body=EXCLUDED\.body, http_status=EXCLUDED\.http_status, received_at=now\(\)/
  );
  assert.equal(params[0], 7);
  assert.equal(params[1], JSON.stringify({ ref: "refs/heads/main" }));
  assert.equal(params[2], 401);
});

test("R3 probeStatement 在 body/httpStatus 缺省时写空对象与 null", () => {
  const { params } = probeStatement(1, undefined);
  assert.equal(params[1], "{}");
  assert.equal(params[2], null);
});

test("recordProbe 成功时按 UPSERT 落库一次（body 与 http_status 一并写）", async () => {
  const seen = [];
  await recordProbe(3, { a: 1 }, 200, async (sql, params) => { seen.push([sql, params]); });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][1][0], 3);
  assert.deepEqual(JSON.parse(seen[0][1][1]), { a: 1 });
  assert.equal(seen[0][1][2], 200);
});

test("recordProbe 写库失败只告警，不抛出（绝不影响 webhook 主流程）", async () => {
  const warn = [];
  const orig = console.warn;
  console.warn = (...args) => warn.push(args.join(" "));
  try {
    await recordProbe(9, { a: 1 }, 401, async () => { throw new Error("db down"); });
  } finally {
    console.warn = orig;
  }
  assert.equal(warn.length, 1);
  assert.match(warn[0], /探针写入失败 pipeline=9/);
});

// 用注入的 resolve/probe/run 驱动 webhook，不依赖真实库
function harness({ secret, run } = {}) {
  const probes = [];
  const runs = [];
  return {
    probes,
    runs,
    resolve: async () => ({ pipelineId: 42, webhookSecret: secret }),
    // runsAtRecord 固化「探针在处理结束后记录」这一时机契约（P1-3）
    probe: async (pipelineId, body, httpStatus) => {
      probes.push({ pipelineId, body, httpStatus, runsAtRecord: runs.length });
    },
    run: async (arg) => { runs.push(arg); return (run ? run(arg) : { waiting: "n1" }); },
  };
}

test("R3 webhook 触发成功：探针记一次且带 http_status=200（run 之后）", async () => {
  const h = harness({ secret: "s3cret" });
  const out = await webhook(h.run, {
    pipelineName: "svcA", payload: { ref: "main" }, authority: "ctl.example", secret: "s3cret",
    resolve: h.resolve, probe: h.probe,
  });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { ok: true, waiting: "n1" });
  assert.equal(h.probes.length, 1, "一次性 UPSERT，不再前后各记一次");
  assert.deepEqual(h.probes[0], { pipelineId: 42, body: { ref: "main" }, httpStatus: 200, runsAtRecord: 1 });
  assert.deepEqual(h.runs, [{ pipelineId: 42, payload: { ref: "main" }, authority: "ctl.example" }]);
});

test("R3 webhook 密钥错误：探针仍记录（含密钥错误的投递），但带 http_status=401", async () => {
  const h = harness({ secret: "s3cret" });
  const out = await webhook(h.run, {
    pipelineName: "svcA", payload: { whatever: true }, authority: null, secret: "wrong",
    resolve: h.resolve, probe: h.probe,
  });
  assert.equal(out.status, 401);
  assert.equal(out.body.code, "UNAUTHORIZED");
  assert.deepEqual(h.probes, [{ pipelineId: 42, body: { whatever: true }, httpStatus: 401, runsAtRecord: 0 }]);
  assert.equal(h.runs.length, 0);
});

test("R3 webhook 密钥未配置：503 HOOK_NOT_CONFIGURED 且探针记 503", async () => {
  const h = harness({ secret: "" });
  const out = await webhook(h.run, {
    pipelineName: "svcA", payload: null, secret: "x", resolve: h.resolve, probe: h.probe,
  });
  assert.equal(out.status, 503);
  assert.equal(out.body.code, "HOOK_NOT_CONFIGURED");
  assert.deepEqual(h.probes, [{ pipelineId: 42, body: {}, httpStatus: 503, runsAtRecord: 0 }]);
});

test("R3 webhook 执行抛错：探针按 500 记录后原样上抛（面板不再显示成已收到即跑通）", async () => {
  const h = harness({ secret: "s3cret", run: () => { throw new Error("boom"); } });
  await assert.rejects(
    () => webhook(h.run, {
      pipelineName: "svcA", payload: { a: 1 }, secret: "s3cret", resolve: h.resolve, probe: h.probe,
    }),
    /boom/
  );
  assert.deepEqual(h.probes, [{ pipelineId: 42, body: { a: 1 }, httpStatus: 500, runsAtRecord: 1 }]);
});

test("R3 管道未命中（resolve 抛错）时无法定位 id，不记探针", async () => {
  const h = harness({ secret: "s3cret" });
  await assert.rejects(
    () => webhook(h.run, {
      pipelineName: "ghost", payload: {}, secret: "s3cret",
      resolve: async () => { throw new Error("pipeline not found: ghost"); }, probe: h.probe,
    }),
    /pipeline not found/
  );
  assert.equal(h.probes.length, 0);
});

test("R1+R2+R3 真走 handler 入口：中文名解码、secret 生效、401 如实回给第三方并留探针", async () => {
  const { handler } = await import("../index.js");
  const seen = [];
  pool.query = async (sql, params) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    seen.push({ sql: s, params });
    if (/^SELECT id, webhook_secret FROM pipeline WHERE name=\$1$/.test(s)) {
      return { rows: [{ id: 77, webhook_secret: "s3cret" }] };
    }
    return { rows: [] };
  };
  let res;
  try {
    res = await handler({
      httpMethod: "POST",
      path: `/hook/webhook/${encodeURIComponent("发布")}?secret=wrong`,
      headers: { host: "ctl.example.com", "content-type": "application/json" },
      body: JSON.stringify({ ref: "refs/heads/main" }),
    });
  } finally {
    delete pool.query;
  }
  assert.equal(res.statusCode, 401, "密钥不匹配必须以 401 回应第三方（不能再被包成 200）");
  assert.deepEqual(JSON.parse(res.body), { ok: false, code: "UNAUTHORIZED", message: "webhook 密钥错误" });
  const lookup = seen.find((x) => /^SELECT id, webhook_secret FROM pipeline/.test(x.sql));
  assert.deepEqual(lookup.params, ["发布"], "百分号编码的中文管道名必须解码后再查库");
  const probe = seen.find((x) => /^INSERT INTO webhook_probe/.test(x.sql));
  assert.equal(probe.params[0], 77);
  assert.deepEqual(JSON.parse(probe.params[1]), { ref: "refs/heads/main" });
  assert.equal(probe.params[2], 401, "探针必须带上本次处理结果");
});

// ---------- R4/R5：改名生效与返显去敏 ----------
test("R5 PIPELINE_COLUMNS 不含 webhook_secret，且覆盖编辑返显所需列", () => {
  assert.doesNotMatch(PIPELINE_COLUMNS, /webhook_secret/);
  for (const c of ["id", "name", "description", "spec_json", "rev", "created_at", "updated_at"]) {
    assert.match(PIPELINE_COLUMNS, new RegExp(`(^|, )${c}(, |$)`), `缺列 ${c}`);
  }
});

test("R4/R5 管道 CRUD 四处 SQL 共用同一列清单，create/update 不再 RETURNING *", async () => {
  const COLS = "id, name, description, spec_json, rev, created_at, updated_at";
  const PIPE_ROW = { id: 5, name: "n", description: "d", spec_json: {}, rev: 1, created_at: null, updated_at: null };
  const stmts = [];
  pool.query = async (sql, params) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    stmts.push({ sql: s, params });
    if (/^INSERT INTO pipeline\(/.test(s)) return { rows: [PIPE_ROW] };
    if (/^UPDATE pipeline SET/.test(s)) return { rows: [{ ...PIPE_ROW, rev: 2 }] };
    return { rows: [PIPE_ROW] };
  };
  try {
    await listPipelines();
    await getPipeline(5);
    await createPipeline({ name: "n", description: "d", spec_json: { nodes: [] } });
    await updatePipeline(5, { name: "改名后", description: "d2", spec_json: { nodes: [] } });
  } finally {
    delete pool.query; // pg.Pool 的 query 在原型上，删掉自有属性即还原
  }
  const pipelineSql = stmts.filter((s) => /\bFROM pipeline\b|INTO pipeline\(|UPDATE pipeline SET/.test(s.sql));
  assert.equal(pipelineSql.length, 4, `应捕获 4 条 pipeline 语句，实际：${JSON.stringify(pipelineSql.map((x) => x.sql))}`);
  for (const { sql } of pipelineSql) {
    // 读接口看 SELECT 列、写接口看 RETURNING 列，两侧都必须等于同一份列清单且不含密钥
    const list = /RETURNING/.test(sql)
      ? sql.split("RETURNING")[1]
      : sql.split("SELECT")[1].split("FROM pipeline")[0];
    assert.ok(list.trim().startsWith(COLS), `列清单与共享常量不一致：${sql}`);
    assert.doesNotMatch(list, /webhook_secret/, `返显泄漏密钥：${sql}`);
    assert.doesNotMatch(sql, /RETURNING \*/);
  }
  // R4：改名/改描述真的进 SET，且按位序带上值
  const upd = pipelineSql.find((s) => /UPDATE pipeline SET/.test(s.sql));
  assert.match(upd.sql, /SET name=\$2, description=\$3, spec_json=\$4::jsonb, rev=rev\+1, updated_at=now\(\)/);
  assert.deepEqual(upd.params, [5, "改名后", "d2", JSON.stringify({ nodes: [] })]);
  // INSERT 仍写入密钥（只在 VALUES 侧，不出现在 RETURNING 侧）
  const ins = pipelineSql.find((s) => /INSERT INTO pipeline\(/.test(s.sql));
  assert.match(ins.sql, /INSERT INTO pipeline\(name, description, spec_json, webhook_secret\)/);
});

test("R5 getWebhookSecret 仍显式回密钥（去敏只针对返显列，不改变显式获取入口）", async () => {
  pool.query = async () => ({ rows: [{ name: "svcA", webhook_secret: "s3cret" }] });
  try {
    const { getWebhookSecret } = await import("../handlers/api.js");
    const out = await getWebhookSecret(5, { base: "http://ctl.example" });
    assert.equal(out.secret, "s3cret");
    assert.equal(out.url, "http://ctl.example/hook/webhook/svcA?secret=s3cret");
  } finally {
    delete pool.query;
  }
});

// ---------- 路由双注册 ----------
test("routeToHandler 命中的处理器在 DISPATCH 中都有登记（双注册，缺一必 404）", () => {
  const routes = [
    ["/hook/webhook/svcA", "POST"],
    ["/api/pipelines/9/webhook-secret", "GET"],
    ["/api/pipelines/9/webhook-secret/reset", "POST"],
    ["/api/pipelines/9/webhook-probe", "GET"],
    ["/api/pipelines", "GET"],
    ["/api/pipelines/9", "GET"],
    ["/api/pipelines/9/run", "POST"],
    ["/api/executions/3/rerun", "POST"],
    ["/hook/dingtalk/card/tk", "POST"],
    ["/_/hook/ecidone/1", "POST"],
    ["/_/hook/job/tk9", "GET"],
  ];
  for (const [path, method] of routes) {
    const { handler } = routeToHandler(path, method, {});
    assert.notEqual(handler, "404", `${method} ${path} 未被路由`);
    assert.ok(isDispatched(handler), `${handler} 缺少 DISPATCH 登记`);
  }
});
