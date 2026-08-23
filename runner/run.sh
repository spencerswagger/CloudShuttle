#!/bin/sh
set -e
# 读取控制面下发环境变量：CLOUDSHUTTLE_JOB_URL, CLOUDSHUTTLE_TOKEN, CLOUDSHUTTLE_EXEC_ID, CLOUDSHUTTLE_NODE_ID, CLOUDSHUTTLE_CB_BASE
echo "fetching job spec..."
JOB=$(curl -fsS -H "Authorization: Bearer $CLOUDSHUTTLE_TOKEN" "$CLOUDSHUTTLE_JOB_URL")
echo "$JOB" | jq -r .command > /tmp/cmd.sh
chmod +x /tmp/cmd.sh
set +e
/tmp/cmd.sh
RC=$?
set -e
if [ "$RC" -eq 0 ]; then
  curl -fsS -X POST "${CLOUDSHUTTLE_CB_BASE}/_/hook/ecidone/${CLOUDSHUTTLE_EXEC_ID}?token=${CLOUDSHUTTLE_TOKEN}" -H 'content-type: application/json' -d '{"ok":true}'
else
  curl -fsS -X POST "${CLOUDSHUTTLE_CB_BASE}/_/hook/fail/${CLOUDSHUTTLE_EXEC_ID}?token=${CLOUDSHUTTLE_TOKEN}" -H 'content-type: application/json' -d "{\"reason\":\"exit $RC\"}"
fi
exit $RC