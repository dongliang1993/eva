-- T45b:plan review 平行决策通道。老行 kind 默认 'tool',status 的 granted/denied 读法不变;
-- 新增三值 revise/reject_and_exit/dismissed 只给 plan review 写(SQLite text 列无 CHECK,语义在 schema.ts)。
ALTER TABLE `approval_requests` ADD COLUMN `kind` text NOT NULL DEFAULT 'tool';
--> statement-breakpoint
ALTER TABLE `approval_requests` ADD COLUMN `decision` text;
