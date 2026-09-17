-- deploy/seed.sql —— 示例管道（幂等可重入）
-- 预置镜像已由版本化迁移 002_ci_images.sql 统一负责（存量库升级自动补全），这里不再重复插入，
-- 避免「seed 双份 + 老版本镜像残留」的困惑。
-- 示例管道 demo-rollout：用存在性守卫保证全局仅创建一次（不会每次启动重复建），
--   并同步写入 pipeline_rev，否则按 spec 加载时读不到 nodes。

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