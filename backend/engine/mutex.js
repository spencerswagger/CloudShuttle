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