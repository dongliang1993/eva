import type { AgentModel } from "../models/agent-model.js";
import type { AgentTool } from "../tools.js";
import { createAgent } from "../agents/create-agent.js";
import type { SubagentConfig, SubagentResult } from "./types.js";

const DEFAULT_MAX_STEPS = 25;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_DISALLOWED_TOOLS: readonly string[] = ["task"];

const filterTools = (
  tools: readonly AgentTool[],
  allowed: readonly string[] | undefined,
  disallowed: readonly string[] | undefined
): AgentTool[] => {
  let filtered: AgentTool[] = [...tools];

  if (allowed !== undefined) {
    const allowedSet = new Set(allowed);
    filtered = filtered.filter((t) => allowedSet.has(t.name));
  }

  const disallowedSet = new Set(disallowed ?? DEFAULT_DISALLOWED_TOOLS);

  return filtered.filter((t) => !disallowedSet.has(t.name));
};

export interface SubagentExecutorOptions {
  readonly config: SubagentConfig;
  readonly tools: readonly AgentTool[];
  readonly model: AgentModel;
}

export class SubagentExecutor {
  private readonly config: SubagentConfig;
  private readonly tools: AgentTool[];
  private readonly model: AgentModel;

  constructor(options: SubagentExecutorOptions) {
    this.config = options.config;
    this.tools = filterTools(
      options.tools,
      options.config.tools,
      options.config.disallowedTools
    );
    this.model = options.model;
  }

  async execute(prompt: string): Promise<SubagentResult> {
    const maxSteps = this.config.maxSteps ?? DEFAULT_MAX_STEPS;
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();

    const agent = createAgent({
      model: this.model,
      tools: this.tools,
      systemPrompt: this.config.systemPrompt,
      maxSteps
    });

    try {
      const result = await Promise.race([
        agent.invoke({ messages: [{ role: "user", content: prompt }] }),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`Subagent timed out after ${timeoutMs}ms`)),
            timeoutMs
          );
        })
      ]);

      return {
        text: result.text,
        status: "completed",
        durationMs: Date.now() - start
      };
    } catch (error) {
      const durationMs = Date.now() - start;
      const message =
        error instanceof Error ? error.message : "Unknown error";
      const isTimeout = message.includes("timed out");

      return {
        text: "",
        status: isTimeout ? "timed_out" : "failed",
        durationMs,
        error: message
      };
    }
  }
}
