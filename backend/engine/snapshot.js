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