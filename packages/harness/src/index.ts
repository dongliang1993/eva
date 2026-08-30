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
  autoSelectSkills,
  createReadSkillTool,
  loadSkills,
  skillsToPromptSection,
} from "./skills/index.js";
export type { AutoSelectSkillsResult, Skill } from "./skills/index.js";

// Tool construction and built-in tools
export {
  buildJsonSchemaTool,
  buildTool,
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
  createPlanWeaveTools,
  createReadFileTool,
  createReadMemoryFileTool,
  createSaveMemoryTool,
  createSearchMemoryTool,
  createUpdateLongTermMemoryTool,
  createWebFetchTool,
  createWriteTool,
  isSafeReadOnlyCommand,
  matchesPlanGatePath,
  planInputSchema,
} from "./tools/index.js";
export type {
  AgentTool,
  MemoryCategory,
  MemoryEntry,
  MemoryStore,
  PlanBlockInput,
  PlanGateHandle,
  PlanGateState,
  PlanGateStore,
  PlanInput,
  PlanTaskInput,
  PlanWeaveGateway,
  RequestPlanReview,
} from "./tools/index.js";
export { buildPolicyKeys } from "./approval/policy-key.js";

// Subagent host contract
export {
  canSpawnAtDepth,
  createReportTool,
  createSubagentTool,
  CrewRegistry,
  filterToolsForRole,
  formatSubagentNotice,
  MAX_DEPTH,
  missingRoleTools,
  runSubagent,
  SUBAGENT_MAX_STEPS,
} from "./subagents/index.js";
export type {
  CreateTaskInput,
  ForkRunner,
  SubagentEventSink,
  SubagentNotice,
  SubagentRole,
  TaskRecord,
  TaskStore,
} from "./subagents/index.js";
