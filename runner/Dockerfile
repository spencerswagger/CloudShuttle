# 基镜像含 docker CLI 与打包工具；戴有 shell 即满足用户自定义命令
FROM docker:27.5-cli
RUN apk add --no-cache git curl jq ca-certificates \
  && curl -LO "https://dl.k8s.io/release/v1.31.0/bin/linux/amd64/kubectl" \
  && install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl \
  && pip3 install --break-system-packages s3cmd 2>/dev/null || true
COPY run.sh /app/run.sh
ENTRYPOINT ["/bin/sh", "/app/run.sh"]