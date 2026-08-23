-- deploy/seed.sql —— 预置镜像与示例管道
-- 依赖 backend/db/schema.sql 已建表（exec_image / pipeline），迁移后可重复执行（幂等）。
-- 注意列名与 backend/db/schema.sql 保持一致：
--   exec_image: name, image, category, builtin
--   pipeline:   name, description, spec_json

INSERT INTO exec_image(name, image, category, builtin) VALUES
 ('Node 20','node:20-alpine','language',true),
 ('Golang 1.23','golang:1.23','language',true),
 ('Python 3.12','python:3.12-slim','language',true),
 ('Java 21','eclipse-temurin:21-jdk','language',true),
 ('Docker+Git 构建','cloudshuttle/runner:0.1','toolchain',true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO pipeline(name, description, spec_json) VALUES (
  'demo-rollout',
  '示例：echo 串一个审批卡点',
  '{"nodes":[
     {"id":"n1","step":"shell","type":"shell","params":{"image":"alpine","command":"echo build-ok"}},
     {"id":"n2","step":"approval","type":"approval","params":{"robot":"demo-robot","approverUid":"<你的openId>","message":"确认发布?"}}
   ],
   "edges":[{"from":"n1","to":"n2"}]}'
)
ON CONFLICT (name) DO NOTHING;