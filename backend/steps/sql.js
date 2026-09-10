// SQL 节点的 stepRun 实现：后端直连数据库，单事务内逐条执行多条语句。
// 任一语句失败：回显已成功语句 → 回滚 → 抛含失败位置的错误，绝不让连接悬挂。
export function coerceTimeout(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n * 1000 : undefined; // 秒 → 毫秒
}

function withTimeout(promise, ms, message) {
  if (!ms) return promise;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

function readableError(err) {
  return String(err?.message ?? err).split("\n")[0].slice(0, 300);
}

// 输出绑定：无 column → 最后一条语句的受影响/返回行数；有 column → 最后结果集首行该列。
export function buildOutput(outputs, lastResult) {
  const out = {};
  const first = (lastResult?.rows?.[0] ?? {});
  for (const o of Array.isArray(outputs) ? outputs : []) {
    const key = o?.key;
    if (!key) continue;
    if (o?.column) {
      const v = first[o.column];
      out[key] = v === undefined ? "" : String(v);
    } else {
      out[key] = String(lastResult?.rowCount ?? 0);
    }
  }
  return out;
}

// 依赖注入：getCredentialKind/getCredentialSecrets 沿 shell/approval 既有模式注入；createConnection 由 providers/db 提供。
export function makeSqlStep({ getCredentialKind, getCredentialSecrets, createConnection }) {
  return async function sqlStep(node, ctx) {
    const p = node.params;
    const credential = p?.credential;
    if (!credential) throw new Error("SQL 节点未选择数据库连接凭证");
    const kind = await getCredentialKind(credential);
    if (kind !== "mysql" && kind !== "pg") {
      throw new Error(`凭证 "${credential}" 不是数据库凭证（当前类型：${kind || "未找到"}），请选择 mysql/pg 类型凭证`);
    }
    const secret = await getCredentialSecrets(credential);
    const statements = (Array.isArray(p?.statements) ? p.statements : [])
      .map((s) => String(s ?? "").trim())
      .filter(Boolean);
    if (!statements.length) throw new Error("SQL 节点未填写任何可执行的 SQL 语句");

    const timeoutMs = coerceTimeout(p?.timeout);
    let conn;
    try {
      conn = await createConnection(kind, secret);
    } catch (e) {
      throw new Error(`SQL 节点连接数据库失败：${readableError(e)}`);
    }
    const logs = [];
    let succeeded = 0;
    let lastResult = { rows: [], rowCount: 0, insertId: null };
    let phase; // 失败阶段：begin / statement / commit，用于精准定位报错位置
    try {
      phase = "begin";
      await withTimeout(conn.begin(), timeoutMs, "SQL 节点开启事务超时");
      phase = "statement";
      for (const stmt of statements) {
        const r = await withTimeout(conn.query(stmt), timeoutMs, "SQL 节点执行语句超时");
        lastResult = r;
        succeeded++;
        logs.push(
          `✓ ${succeeded}. 执行成功（影响/返回 ${r.rowCount} 行${r.insertId != null ? `，自增 id=${r.insertId}` : ""}）`
        );
      }
      phase = "commit";
      await withTimeout(conn.commit(), timeoutMs, "SQL 节点提交事务超时");
    } catch (err) {
      const isTimeout = String(err?.message ?? "").includes("超时");
      try {
        // 超时：断连让服务端自动回滚事务（查询可能仍挂起，显式 ROLLBACK 会与之竞争）；非超时：显式回滚
        if (isTimeout) await conn.destroy?.();
        else await conn.rollback();
      } catch { /* 回滚/断连失败不掩盖原错误 */ }
      const where =
        phase === "begin" ? "开启事务失败"
        : phase === "commit" ? "提交事务出错"
        : `第 ${succeeded + 1} 条语句出错`;
      const readback = logs.length ? `；已成功执行 ${succeeded} 条：\n` + logs.join("\n") : "；无已成功语句";
      throw new Error(`SQL 节点执行失败：${where}${readback}\n原因：${readableError(err)}`);
    } finally {
      try { await conn.end(); } catch { /* 忽略关闭错误 */ }
    }
    return { kind: "done", output: buildOutput(p?.outputs, lastResult), logs: logs.join("\n") };
  };
}
