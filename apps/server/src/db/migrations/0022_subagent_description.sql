-- S7 push:subagent 工具的 description(3-5 词任务名)。
-- 卡片标题与注入给模型的通知文本都用它 —— 没有它,并行派出的多个子代理
-- 在 UI 上全是同一个角色名,无法分辨谁是谁。
-- 已有行补空串(旧任务没有这个字段,不回填假名字)。
ALTER TABLE `background_tasks` ADD COLUMN `description` text NOT NULL DEFAULT '';
