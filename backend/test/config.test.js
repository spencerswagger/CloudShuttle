// backend/test/config.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";

test("config 提供默认连接信息", () => {
  assert.equal(config.pg.host, "localhost");
  assert.equal(config.redis.url, "redis://127.0.0.1:6379");
});