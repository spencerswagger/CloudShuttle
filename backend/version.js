// 启动版本指纹：优先读构建期固化的 VERSION 文件；本地开发无该文件时回退 dev
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, "VERSION");

export function getBuild() {
  try {
    const v = readFileSync(file, "utf8").trim();
    return v || "dev";
  } catch {
    return "dev";
  }
}