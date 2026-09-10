-- 002: 钉钉企业机器人凭证的展示辅助信息（企业名称/应用名称/应用图标）
-- 保存凭证时经钉钉 API 拉取并落库，供下拉框等辅助区分；非敏感展示字段
ALTER TABLE credential ADD COLUMN IF NOT EXISTS display_meta JSONB NOT NULL DEFAULT '{}'::jsonb;