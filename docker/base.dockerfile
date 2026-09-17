# ci-base: 语言无关的通用 CI 基底（curl+git+openssh+docker-cli+kaniko）
FROM alpine:3.20
RUN apk add --no-cache curl git openssh-client ca-certificates make docker-cli
COPY --from=gcr.io/kaniko-project/executor:v1.23.2 /kaniko/executor /usr/local/bin/kaniko
