CREATE TABLE `mcp_servers` (
  `id` text PRIMARY KEY NOT NULL,
  -- 工具名前缀。限 [a-z0-9_-]+，唯一 —— mcp__<name>__<tool> 必须能被稳定解析
  `name` text NOT NULL,
  -- manual = UI 建的；file = 从 ~/.eva/mcp.json 同步来的（UI 只能启停）
  `origin` text NOT NULL DEFAULT 'manual',
  `transport` text NOT NULL,
  `command` text,
  `args` text NOT NULL DEFAULT '[]',
  `env` text NOT NULL DEFAULT '{}',
  `url` text,
  `headers` text NOT NULL DEFAULT '{}',
  -- 免审批工具名白名单（不含 mcp__ 前缀，写 MCP 侧原名）
  `auto_approve_tools` text NOT NULL DEFAULT '[]',
  `enabled` integer NOT NULL DEFAULT 1,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_mcp_servers_name` ON `mcp_servers` (`name`);
--> statement-breakpoint
CREATE INDEX `idx_mcp_servers_origin` ON `mcp_servers` (`origin`);
