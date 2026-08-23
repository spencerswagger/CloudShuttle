import smcrypto from "sm-crypto";
import { Buffer } from "node:buffer";

const { sm4 } = smcrypto;

const utf8 = { input: "utf8", output: "utf8", mode: "ecb", padding: "pkcs#7" };

function normalizeKey(key) {
  // 接受 16 字节 hex（32 chars）或直接 16 字节字符串
  return key.length === 32 ? key : Buffer.from(key, "utf8").toString("hex");
}

export function sm4Encrypt(key, obj) {
  const hexKey = normalizeKey(key);
  const text = JSON.stringify(obj);
  return sm4.encrypt(text, hexKey, utf8);
}

export function sm4Decrypt(key, cipher) {
  const hexKey = normalizeKey(key);
  try {
    return JSON.parse(sm4.decrypt(cipher, hexKey, utf8));
  } catch {
    throw new Error("SM4 decrypt failed");
  }
}