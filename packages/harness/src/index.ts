// Agent runtime
export { createAgent } from "./agents/agent.js";
export type {
  Agent,
  AgentCallSettings,
  AgentRunInput,
  AgentRunResult,
  AgentStreamEvent,
  AgentToolCallResult,
  CreateAgentOptions,
  RequestApproval,
  ToolApprovalRequest,
} from "./agents/types.js";
export type { AgentObserver, AgentTelemetryEvent } from "./agents/observer.js";

// Models and prompts
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

// Tool construction and built-in tools
export {
  aborted,
  classifyToolRisk,
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
  isSafeReadOnlyCommand,
  matchesPlanGatePath,
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
  RequestPlanReview,
  ToolResult,
} from "./tools/index.js";
export { buildPolicyKeys } from "./approval/policy-key.js";

// Subagent host contract
export {
  createSubagentTool,
  SUBAGENT_ROLES,
  filterToolsForRole,
  missingRoleTools,
  SUBAGENT_MAX_STEPS,
} from "./subagents/index.js";
export type {
  ForkRunner,
  SubagentEventSink,
  SubagentRole,
  TaskRecord,
} from "./subagents/index.js";
