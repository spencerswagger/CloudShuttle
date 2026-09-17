-- 002_ci_images.sql —— 预置平台 CI 镜像（幂等，存量库升级自动补全）
-- 镜像由仓库内 .github/workflows/build-ci-images.yml 构建推送（workflow_dispatch 手动触发），
-- 目标地址写死 registry.cn-hangzhou.aliyuncs.com/spencerswagger/*。
-- exec_image.name 的唯一约束是「部分唯一索引」（软删除改造），ON CONFLICT 列推断匹配不到，
-- 沿用 seed 的逐行存在性守卫写法，对新库/存量库都幂等安全。
DO $$
BEGIN
  -- base（通用工具基底：curl+git+openssh+docker-cli+kaniko）
  IF NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'CI Base' AND deleted_at IS NULL) THEN
    INSERT INTO exec_image(name, image, category, builtin)
    VALUES('CI Base', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-base:latest', 'toolchain', true);
  END IF;
  -- Node（14~24 大版本）
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Node 14', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-node:14', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Node 14' AND deleted_at IS NULL);
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Node 16', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-node:16', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Node 16' AND deleted_at IS NULL);
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Node 18', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-node:18', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Node 18' AND deleted_at IS NULL);
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Node 20', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-node:20', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Node 20' AND deleted_at IS NULL);
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Node 22', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-node:22', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Node 22' AND deleted_at IS NULL);
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Node 24', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-node:24', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Node 24' AND deleted_at IS NULL);
  -- Python（3.7~3.13）
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Python 3.7', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-python:3.7', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Python 3.7' AND deleted_at IS NULL);
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Python 3.8', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-python:3.8', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Python 3.8' AND deleted_at IS NULL);
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Python 3.9', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-python:3.9', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Python 3.9' AND deleted_at IS NULL);
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Python 3.10', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-python:3.10', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Python 3.10' AND deleted_at IS NULL);
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Python 3.11', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-python:3.11', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Python 3.11' AND deleted_at IS NULL);
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Python 3.12', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-python:3.12', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Python 3.12' AND deleted_at IS NULL);
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Python 3.13', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-python:3.13', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Python 3.13' AND deleted_at IS NULL);
  -- Go（1.19~1.23）
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Go 1.19', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-golang:1.19', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Go 1.19' AND deleted_at IS NULL);
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Go 1.20', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-golang:1.20', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Go 1.20' AND deleted_at IS NULL);
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Go 1.21', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-golang:1.21', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Go 1.21' AND deleted_at IS NULL);
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Go 1.22', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-golang:1.22', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Go 1.22' AND deleted_at IS NULL);
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Go 1.23', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-golang:1.23', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Go 1.23' AND deleted_at IS NULL);
  -- Java（Eclipse Temurin 8/11/17/21）
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Java 8', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-java:8', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Java 8' AND deleted_at IS NULL);
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Java 11', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-java:11', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Java 11' AND deleted_at IS NULL);
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Java 17', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-java:17', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Java 17' AND deleted_at IS NULL);
  INSERT INTO exec_image(name, image, category, builtin)
  SELECT 'Java 21', 'registry.cn-hangzhou.aliyuncs.com/spencerswagger/ci-java:21', 'language', true
  WHERE NOT EXISTS (SELECT 1 FROM exec_image WHERE name = 'Java 21' AND deleted_at IS NULL);
END $$;