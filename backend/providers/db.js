// 数据库连接代理：统一 mysql(2)/pg 的建连与查询返回形状，屏蔽驱动差异。
// buildDbConfig 是纯函数（固定字段 + extra 合并、类型化、ssl 语义映射），可独立单测。
import pg from "pg";
import mysql from "mysql2/promise";

// 值轻量类型化：数值 / 'true'|'false' / JSON，否则保留字符串。
// 让 connectTimeout=10000、statement_timeout=5000、ssl=true 等可直接作普通自定义项。
export function coerceExtraValue(v) {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (s === "") return s;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  const lower = s.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  try { return JSON.parse(s); } catch { return s; }
}

// ssl 语义串 → 驱动可用的 ssl 配置（布尔或对象）；未命中的字符串回退给 coerceExtraValue。
const SSL_MODE_MAP = {
  "true": true,
  "false": false,
  "disable": false,
  "require": { rejectUnauthorized: false },
  "verify-ca": { rejectUnauthorized: true },
};

// 固定字段与代码声明保留键：extra 不得覆盖（防止 extra 注入 host 劫持连接目标、multipleStatements 绕过逐条下发）。
const RESERVED_CFG_KEYS = new Set(["host", "port", "user", "password", "database", "multipleStatements"]);

// 纯函数：把解密后的凭证对象 → 驱动 config。
// secret 形如 { host, port?, user, password, database, extra?: [{key,value}] }
export function buildDbConfig(kind, secret) {
  const portDefault = kind === "pg" ? 5432 : 3306;
  const cfg = {
    host: secret?.host,
    port: Number(secret?.port ?? portDefault),
    user: secret?.user,
    password: secret?.password,
    database: secret?.database,
  };
  for (const item of Array.isArray(secret?.extra) ? secret.extra : []) {
    const k = item?.key;
    const v = item?.value;
    if (!k || RESERVED_CFG_KEYS.has(k)) continue;
    if (k === "ssl") cfg.ssl = SSL_MODE_MAP[String(v).toLowerCase()] ?? coerceExtraValue(v);
    else cfg[k] = coerceExtraValue(v);
  }
  // 建连也受超时保护：pg 未显式配置连接超时则给默认 10s（mysql2 驱动自带 connectTimeout 默认）。
  if (kind === "pg" && cfg.connectionTimeoutMillis === undefined) {
    cfg.connectionTimeoutMillis = 10000;
  }
  // secret 顶层若已含驱动级连接超时键则保留（显式值优先于默认），
  // 使「cfg 作为 secret 透传」场景（如 testCredentialConnection 二次建连）幂等安全。
  // 非法值（非有限数值）忽略不写入，防止驱动收到 NaN 超时（如 "abc" 被 Number() 成 NaN）。
  const numOr = (v) => {
    if (typeof v === "string" && v.trim() === "") return undefined;
    return Number.isFinite(Number(v)) ? Number(v) : undefined;
  };
  const ct = numOr(secret?.connectTimeout);
  if (ct != null) cfg.connectTimeout = ct;
  const cm = numOr(secret?.connectionTimeoutMillis);
  if (cm != null) cfg.connectionTimeoutMillis = cm;
  return cfg;
}

async function openPg(cfg) {
  const client = new pg.Client(cfg);
  await client.connect();
  return {
    async begin() { await client.query("BEGIN"); },
    async query(sql) {
      const r = await client.query(sql);
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? 0, insertId: null };
    },
    async commit() { await client.query("COMMIT"); },
    async rollback() { await client.query("ROLLBACK"); },
    async end() { await client.end(); },
    destroy() { try { client.connection?.stream?.destroy(); } catch { /* 忽略断连错误 */ } },
  };
}

async function openMysql(cfg) {
  // 不支持 multipleStatements；事务由 BEGIN/COMMIT 手工管理，语句逐条下发
  const conn = await mysql.createConnection(cfg);
  return {
    async begin() { await conn.query("START TRANSACTION"); },
    async query(sql) {
      const [results] = await conn.query(sql);
      // SELECT → rows 数组；写语句 → OkPacket（含 affectedRows/insertId）
      return {
        rows: Array.isArray(results) ? results : [],
        rowCount: results?.affectedRows ?? (Array.isArray(results) ? results.length : 0),
        insertId: results?.insertId ?? null,
      };
    },
    async commit() { await conn.commit(); },
    async rollback() { await conn.rollback(); },
    async end() { await conn.end(); },
    destroy() { conn.destroy(); }, // mysql2 立即断连，同步即可
  };
}

// 按 kind 打开一条连接；不支持的 kind 抛可读错误。
export async function createConnection(kind, secret) {
  const cfg = buildDbConfig(kind, secret);
  if (kind === "pg") return openPg(cfg);
  if (kind === "mysql") return openMysql(cfg);
  throw new Error(`不支持的数据库类型：${kind}`);
}
