import Redis from "ioredis";
import { config } from "../config.js";

export function createRedis(url = config.redis.url) {
  return new Redis(url, { lazyConnect: true });
}
export const redis = createRedis();