#!/bin/sh
set -e
# 控制面下发变量：CLOUDSHUTTLE_JOB_URL, CLOUDSHUTTLE_TOKEN, CLOUDSHUTTLE_CB_SECRET,
# CLOUDSHUTTLE_CB_BASE, CLOUDSHUTTLE_EXEC_ID, CLOUDSHUTTLE_NODE_ID, CLOUDSHUTTLE_OUT_FILE
OUT_FILE="${CLOUDSHUTTLE_OUT_FILE:-/tmp/out}"
LOG_FILE="/tmp/job.log"
: > "$OUT_FILE"                       # 截断输出文件，避免残留旧值
echo "fetching job spec..."
JOB=$(curl -fsS -H "Authorization: Bearer $CLOUDSHUTTLE_TOKEN" "$CLOUDSHUTTLE_JOB_URL")
echo "$JOB" | jq -r .command > /tmp/cmd.sh
chmod +x /tmp/cmd.sh
set +e
/tmp/cmd.sh > "$LOG_FILE" 2>&1        # stdout/stderr 全部进日志；命令向 $CLOUDSHUTTLE_OUT_FILE 写 K=V 实现输出
RC=$?
set -e
OUTJSON=$(jq -Rs . < "$OUT_FILE")
LOGJSON=$(jq -Rs . < "$LOG_FILE")
CB_URL="${CLOUDSHUTTLE_CB_BASE}/_/hook"
if [ "$RC" -eq 0 ]; then
  curl -fsS -X POST "${CB_URL}/ecidone/${CLOUDSHUTTLE_EXEC_ID}?token=${CLOUDSHUTTLE_TOKEN}&secret=${CLOUDSHUTTLE_CB_SECRET}" \
    -H 'content-type: application/json' \
    -d "{\"result\":{\"output\":${OUTJSON},\"logs\":${LOGJSON}}}"
else
  curl -fsS -X POST "${CB_URL}/fail/${CLOUDSHUTTLE_EXEC_ID}?token=${CLOUDSHUTTLE_TOKEN}&secret=${CLOUDSHUTTLE_CB_SECRET}" \
    -H 'content-type: application/json' \
    -d "{\"reason\":\"exit $RC\",\"logs\":${LOGJSON}}"
fi
exit $RC
