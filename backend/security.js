// 回调密钥校验与内网来源判定
import { createHash, timingSafeEqual } from "node:crypto";

// 常数时间比较（对 sha256 摘要比对，避免长度侧信道）
export function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a ?? "")).digest();
  const hb = createHash("sha256").update(String(b ?? "")).digest();
  return timingSafeEqual(ha, hb);
}

// 判定是否为内网/回环地址（联调与 VPC 内 ECI 回调来源都属此列）
export function isPrivateIp(ip) {
  const s = String(ip ?? "").trim();
  if (!s) return false;
  // IPv4 段：10/8、172.16/12、192.168/16、127/8 回环、169.254/16 链路本地
  const v4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a] = v4.slice(1).map(Number);
    const b = Number(v4[2]);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  // IPv6：::1 回环、fc00::/7 唯一本地、fe80::/10 链路本地
  const v6 = s.toLowerCase();
  if (v6 === "::1" || v6 === "0:0:0:0:0:0:0:1") return true;
  if (v6.startsWith("::ffff:127.")) return true;
  return /^(fc|fd|fe8|fe9|fea|feb)/.test(v6);
}

// 从 FC 事件头取来源 IP（x-forwarded-for 首个即可，取原始客户 IP）
export function clientIp(event) {
  const h = event?.headers ?? {};
  const fwd = h["x-forwarded-for"] || h["X-Forwarded-For"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return h["x-real-ip"] || h["X-Real-Ip"] || h.remoteAddr || h["remote_addr"] || h.origin || null;
}