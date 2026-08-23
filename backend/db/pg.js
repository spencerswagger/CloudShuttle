import pg from "pg";
import { config } from "../config.js";

export function createPool(pgConfig = config.pg) {
  return new pg.Pool(pgConfig);
}
export const pool = createPool();