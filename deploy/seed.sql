-- deploy/seed.sql —— 预置镜像与示例管道（只植入一次，幂等可重入）
-- 预置镜像：exec_image.name 有 UNIQUE，ON CONFLICT DO NOTHING 天然幂等。
-- 示例管道 demo-rollout：用存在性守卫保证全局仅创建一次（不会每次启动重复建），
--   并同步写入 pipeline_rev，否则按 spec 加载时读不到 nodes。

INSERT INTO exec_image(name, image, category, builtin) VALUES
 ('Node 20','node:20-alpine','language',true),
 ('Golang 1.23','golang:1.23','language',true),
 ('Python 3.12','python:3.12-slim','language',true),
 ('Java 21','eclipse-temurin:21-jdk','language',true),
 ('Docker+Git 构建','cloudshuttle/runner:0.1','toolchain',true)
ON CONFLICT (name) DO NOTHING;

DO $$
DECLARE
  demo_id BIGINT;
  demo_spec JSONB := '{"nodes":[{"id":"n1","step":"shell","type":"shell","params":{"image":"alpine","command":"echo build-ok"}},{"id":"n2","step":"approval","type":"approval","params":{"robot":"demo-robot","message":"确认发布?"}}],"edges":[{"from":"n1","to":"n2"}]}'::jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pipeline WHERE name = 'demo-rollout') THEN
    INSERT INTO pipeline(name, description, spec_json)
    VALUES ('demo-rollout', '示例：echo 串一个审批卡点', demo_spec)
    RETURNING id INTO demo_id;
    INSERT INTO pipeline_rev(pipeline_id, rev, spec_json)
    VALUES (demo_id, 1, demo_spec);
  END IF;
END $$;