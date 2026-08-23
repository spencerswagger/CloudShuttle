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