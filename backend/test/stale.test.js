import { test } from "node:test";
import assert from "node:assert/strict";
import { staleWaiting } from "../engine/stale.js";

test("staleWaiting：超时未回调节点判 stale，未到期/无派发记录不误判", () => {
  const now = Date.now();
  const sinceOf = (id) => ({ n1: now - 400_000, n2: now - 60_000 })[id]; // n1 超时(>360s)，n2 未到；n3 无记录
  const timeoutOf = (id) => (id === "n2" ? 300 : 300);
  const out = staleWaiting(["n1", "n2", "n3"], sinceOf, timeoutOf, now);
  assert.deepEqual(out, ["n1"]);
});

test("staleWaiting：timeout 为 0/缺省视为 300s；空 waiting 返回空", () => {
  const now = Date.now();
  assert.deepEqual(staleWaiting(null, () => now - 100_000, () => 0, now), []);
  assert.deepEqual(staleWaiting(["a"], () => now - 999_999, () => 0, now), ["a"], "默认 300s+60s 缓冲下仍超时才判 stale");
});