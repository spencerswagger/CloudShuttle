# Java 8 无 alpine 变体，用 Ubuntu Jammy + apt 安装 CI 工具
FROM eclipse-temurin:8-jdk-jammy
RUN apt-get update && apt-get install -y --no-install-recommends curl git openssh-client ca-certificates && rm -rf /var/lib/apt/lists/*
