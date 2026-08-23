-- T40:cache 五元组补全。SDK v7 已标准化 inputTokenDetails.cacheWriteTokens
-- (Anthropic cache_creation_input_tokens 的归一出口,ai@7.0.64),T21 砍掉的
-- cache_write_input_tokens 现在能拿到真实值 —— 补列接回。
-- 历史行默认 0,不回填(同 T21:本地单机库,历史用量无决策价值)。
ALTER TABLE `usage_records` ADD COLUMN `cache_write_input_tokens` integer NOT NULL DEFAULT 0;
