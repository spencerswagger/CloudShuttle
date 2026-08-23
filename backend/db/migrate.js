import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "../db/pg.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");

const client = await pool.connect();
try {
  await client.query(sql);
  console.log("schema applied");
} finally {
  client.release();
  await pool.end();
}