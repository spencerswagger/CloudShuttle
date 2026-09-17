// security.js 单测：内网来源判定（isPrivateIp）与来源 IP 提取（clientIp）
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateIp, clientIp, safeEqual } from "../security.js";

test("isPrivateIp：RFC1918 + 回环 + 链路本地 + 100.64/10 视为内网", () => {
  for (const ip of [
    "10.0.0.1", "10.255.255.255",
    "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "192.168.255.255",
    "100.64.0.1", "100.126.26.224", "100.127.255.255",
    "127.0.0.1",
    "169.254.1.1",
    "::1", "fd00::1", "fe80::1",
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} 应为内网`);
  }
});

test("isPrivateIp：公网地址与 100.64/10 外边界视为非内网", () => {
  for (const ip of [
    "8.8.8.8", "114.114.114.114", "1.1.1.1",
    "100.0.0.1", "100.63.255.255", "100.128.0.1", "100.200.1.1",
    "172.15.0.1", "172.32.0.1", "192.169.0.1",
    "2001:4860:4860::8888",
    "", "not-an-ip",
  ]) {
    assert.equal(isPrivateIp(ip), false, `${ip} 不应视为内网`);
  }
});

test("clientIp：取 x-forwarded-for 首个（原始客户端 IP），多跳含空格可解析", () => {
  assert.equal(clientIp({ headers: { "x-forwarded-for": "100.126.26.224" } }), "100.126.26.224");
  assert.equal(clientIp({ headers: { "x-forwarded-for": " 10.0.0.5, 100.126.26.224 " } }), "10.0.0.5");
  assert.equal(clientIp({ headers: { "X-Forwarded-For": "fc00::1, 8.8.8.8" } }), "fc00::1");
  assert.equal(clientIp({ headers: { "x-real-ip": "10.0.0.9" } }), "10.0.0.9");
  assert.equal(clientIp({ headers: {} }), null);
});

test("safeEqual：常数时间比较正确判定", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("", ""), true);
  assert.equal(safeEqual(null, undefined), true);
});