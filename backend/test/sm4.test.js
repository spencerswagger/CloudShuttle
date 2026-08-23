// backend/test/sm4.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { sm4Encrypt, sm4Decrypt } from "../crypto/sm4.js";

test("SM4 加密后可解密还原", () => {
  const key = "0123456789abcdef0123456789abcdef"; // 32 hex = 16 bytes
  const plain = { ak: "AKID", sk: "SK1234515", bucket: "artifacts" };
  const enc = sm4Encrypt(key, plain);
  assert.notEqual(enc, JSON.stringify(plain));
  assert.deepEqual(sm4Decrypt(key, enc), plain);
});

test("密钥错误解密失败", () => {
  const key = "0123456789abcdef0123456789abcdef";
  const enc = sm4Encrypt(key, { a: 1 });
  assert.throws(() => sm4Decrypt("ffffffffffffffffffffffffffffffff", enc));
});