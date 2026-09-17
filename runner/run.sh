#!/bin/sh
set -e
# 控制面下发变量：CLOUDSHUTTLE_JOB_URL, CLOUDSHUTTLE_TOKEN, CLOUDSHUTTLE_CB_SECRET,
# CLOUDSHUTTLE_CB_BASE, CLOUDSHUTTLE_EXEC_ID, CLOUDSHUTTLE_NODE_ID, CLOUSSHUTTLE_OUT_FILE
OUT_FILE="${CLOUDSHUTTLE_OUT_FILE:-/tmp/out}"
LOG_FILE="/tmp/job.log"
: > "$OUT_FILE"                       # 截断输出文件，避免残留旧值
echo "fetching job spec..."
JOB=$(curl -fsS -H "Authorization: Bearer $CLOUDSHUTTLE_TOKEN" "$CLOUDSHUTTLE_JOB_URL")
echo "$JOB" | jq -r .command > /tmp/cmd.sh
chmod +x /tmp/cmd.sh

# ---------- 附加凭证落盘（v0.2；无 credentials 字段则全部跳过，兼容旧控制面） ----------
setup_all_creds() {
  CREDS=$(echo "$JOB" | jq -c '.credentials // empty')
  [ -z "$CREDS" ] && return 0

  # ssh：私钥 + known_hosts + 可选口令（SSH_ASKPASS）
  SSH_KEY=$(echo "$CREDS" | jq -r '.ssh.privateKey // empty')
  if [ -n "$SSH_KEY" ]; then
    mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
    printf '%s\n' "$SSH_KEY" > "$HOME/.ssh/id_rsa" && chmod 600 "$HOME/.ssh/id_rsa"
    KH=$(echo "$CREDS" | jq -r '.ssh.knownHosts // empty')
    [ -n "$KH" ] && { printf '%s\n' "$KH" > "$HOME/.ssh/known_hosts"; SK=yes; } || SK=accept-new
    PASS=$(echo "$CREDS" | jq -r '.ssh.passphrase // empty')
    if [ -n "$PASS" ]; then
      cat > /tmp/askpass.sh <<EOF
#!/bin/sh
echo "$PASS"
EOF
      chmod 700 /tmp/askpass.sh
      export SSH_ASKPASS=/tmp/askpass.sh SSH_ASKPASS_REQUIRE=force DISPLAY=:0
    fi
    export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/id_rsa -o StrictHostKeyChecking=$SK"
  fi

  # maven：~/.m2/settings.xml（servers + 可选 mirror）
  MVN_ID=$(echo "$CREDS" | jq -r '.maven.serverId // empty')
  if [ -n "$MVN_ID" ]; then
    MVN_USER=$(echo "$CREDS" | jq -r '.maven.username // ""')
    MVN_PASS=$(echo "$CREDS" | jq -r '.maven.password // ""')
    MVN_URL=$(echo "$CREDS" | jq -r '.maven.registryUrl // empty')
    mkdir -p "$HOME/.m2"
    cat > "$HOME/.m2/settings.xml" <<SXML
<settings>
  <servers>
    <server>
      <id>$MVN_ID</id>
      <username>$MVN_USER</username>
      <password>$MVN_PASS</password>
    </server>
  </servers>
SXML
    [ -n "$MVN_URL" ] && cat >> "$HOME/.m2/settings.xml" <<SXML
  <mirrors>
    <mirror>
      <id>$MVN_ID</id>
      <mirrorOf>*</mirrorOf>
      <url>$MVN_URL</url>
    </mirror>
  </mirrors>
SXML
    echo '</settings>' >> "$HOME/.m2/settings.xml"
  fi

  # docker：~/.docker/config.json（auths；容器内 docker build/push 直接生效）
  DKR_REG=$(echo "$CREDS" | jq -r '.docker.registry // empty')
  if [ -n "$DKR_REG" ]; then
    DKR_USER=$(echo "$CREDS" | jq -r '.docker.username // ""')
    DKR_PASS=$(echo "$CREDS" | jq -r '.docker.password // ""')
    DKR_AUTH=$(printf '%s:%s' "$DKR_USER" "$DKR_PASS" | base64)
    mkdir -p "$HOME/.docker"
    printf '{"auths":{"%s":{"auth":"%s"}}}\n' "$DKR_REG" "$DKR_AUTH" > "$HOME/.docker/config.json"
    chmod 600 "$HOME/.docker/config.json"
  fi

  # npm：~/.npmrc（//<host>/:_authToken=）
  NPM_REG=$(echo "$CREDS" | jq -r '.npm.registry // empty')
  NPM_TOKEN=$(echo "$CREDS" | jq -r '.npm.token // empty')
  if [ -n "$NPM_REG" ] && [ -n "$NPM_TOKEN" ]; then
    NPM_HOST=$(echo "$NPM_REG" | sed -E 's#^[a-z][a-z0-9+.-]*://([^/]+).*#\1#')
    [ -n "$NPM_HOST" ] && printf '//%s/:_authToken=%s\n' "$NPM_HOST" "$NPM_TOKEN" >> "$HOME/.npmrc"
  fi

  # s3（s3cmd）：/root/.s3cfg；endpoint 作 host_base，bucket 用于 host_bucket
  S3_AK=$(echo "$CREDS" | jq -r '.s3.ak // empty')
  if [ -n "$S3_AK" ]; then
    S3_ENDPOINT=$(echo "$CREDS" | jq -r '.s3.endpoint // ""')
    S3_BUCKET=$(echo "$CREDS" | jq -r '.s3.bucket // ""')
    S3_SK=$(echo "$CREDS" | jq -r '.s3.sk // ""')
    S3_HB="$S3_ENDPOINT"
    [ -n "$S3_BUCKET" ] && S3_HB="%(bucket)s.$S3_ENDPOINT"
    cat > "$HOME/.s3cfg" <<S3CFG
access_key = $S3_AK
secret_key = $S3_SK
host_base = $S3_ENDPOINT
host_bucket = $S3_HB
S3CFG
    chmod 600 "$HOME/.s3cfg"
  fi
}
setup_all_creds

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