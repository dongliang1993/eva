-- MCP 存储改为 ~/.eva/mcp.json 唯一事实源(文件即存储),mcp_servers 表退役。
-- 表里的条目(含 env/headers 密钥值)由启动迁移 migrateMcpServersToFile 在
-- 删表前一次性写进 mcp.json —— 数据不丢,只是搬家。迁移先跑、本文件后应用。
DROP TABLE IF EXISTS `mcp_servers`;
