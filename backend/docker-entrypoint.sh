#!/bin/sh
set -e

# SKIP_BOOTSTRAP=1 时跳过建表/种子（SAE 冷启动可加快，迁移由部署时手动/CI 执行）
if [ "${SKIP_BOOTSTRAP:-0}" = "1" ]; then
  echo "SKIP_BOOTSTRAP=1, skipping migrate/seed"
  exec node /app/local-server.js
fi

echo "waiting for postgres..."
until pg_isready -h "${PG_HOST:-postgres}" -U "${PG_USER:-cloudshuttle}" -d "${PG_DB:-cloudshuttle}" >/dev/null 2>&1; do
  sleep 2
done

echo "applying schema..."
node /app/db/migrate.js

echo "seeding default images & demo pipeline..."
PGPASSWORD="${PG_PASSWORD:-cloudshuttle}" \
  psql -h "${PG_HOST:-postgres}" -U "${PG_USER:-cloudshuttle}" -d "${PG_DB:-cloudshuttle}" \
  -v ON_ERROR_STOP=1 -f /app/deploy/seed.sql

echo "starting control plane on :9000"
exec node /app/local-server.js