/**
 * harness 公开面(SC-001):query 入口、工具构造、契约类型、内置工具工厂、
 * prompt 段工厂、模型工厂、skill 工具。server 侧的运行时装配
 * (canUseTool 实现等)不在这里 —— 那是 apps/server 的地盘。
 */

// 运行入口
export { query } from "./query/query.js";
export type { Query } from "./query/types.js";
export { evaluatePermission } from "./query/permission.js";
export { runPreToolUse, runPostToolUse, runPostToolUseFailure } from "./query/hooks.js";
export { runToolCall } from "./query/tool-call.js";
export type {
  ToolCallContext,
  ToolCallResult,
  ToolTimingMutable,
} from "./query/tool-call.js";
export type {
  AgentDefinition,
  CanUseTool,
  HarnessMessage,
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
  PermissionResult,
  AssistantMessage,
  CompactBoundaryMessage,
  ModelBinding,
  Options,
  ResultMessage,
  StreamDelta,
  StreamEventMessage,
  SystemInitMessage,
  TokenUsage,
  ToolTiming,
  TurnCompleteMessage,
  UserMessage,
} from "./query/types.js";

// 模型与 prompt
export { createAnthropicModel } from "./models/anthropic.js";
export { createOpenAiCompatibleModel } from "./models/openai-compatible.js";
export type { AgentModel, AgentModelFactory } from "./models/agent-model.js";
export { buildAgentSystemPrompt } from "./prompts/prompt-builder.js";
export type {
  BuildAgentSystemPromptOptions,
  PromptSection,
} from "./prompts/prompt-builder.js";
export { createWebFetchPromptSection } from "./prompts/sections/web-fetch.js";
export { createWebSearchPromptSection } from "./prompts/sections/web-search.js";
export { loadSoulSection } from "./prompts/soul.js";

// Skills
export {
  createReadSkillTool,
  loadSkills,
  skillsToPromptSection,
} from "./skills/index.js";
export type { Skill } from "./skills/index.js";

// 工具构造与内置工具
export {
  aborted,
  createAppendMemoryTool,
  createBashTool,
  createDuckDuckGoWebSearchTool,
  createEditTool,
  createEnterPlanModeTool,
  createExitPlanModeTool,
  createGrepTool,
  createListDirTool,
  createMemoryPromptSection,
  createPlanGateState,
  createReadFileTool,
  createReadMemoryFileTool,
  createSaveMemoryTool,
  createSearchMemoryTool,
  createUpdateLongTermMemoryTool,
  createWebFetchTool,
  createWriteTool,
  errorResult,
  textOf,
  textResult,
  tool,
  toolFromJsonSchema,
  toToolSet,
} from "./tools/index.js";
export type {
  MemoryCategory,
  MemoryEntry,
  MemoryStore,
  PipelineTool,
  PlanGateHandle,
  PlanGateState,
  PlanGateStore,
  ToolResult,
} from "./tools/index.js";
