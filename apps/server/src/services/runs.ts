import type { ModelMessage } from "ai";
import type {
  Agent,
  AgentRunResult,
} from "@eva/harness";
import type { RunAgentStreamEvent } from "@eva/shared";

import type { RunInputMessage, RunInput, RunMessageContent } from "../types/runs.js";

// Normalize legacy LangChain roles (human/ai/function/generic/remove) and the
// generic "developer" role down to the four Vercel ModelMessage roles.
const normalizeRole = (role: RunInputMessage["role"]): ModelMessage["role"] => {
  switch (role) {
    case "human":
      return "user";
    case "ai":
    case "function":
    case "generic":
    case "remove":
      return "assistant";
    case "developer":
      return "system";
    default:
      return role;
  }
};

const toAgentMessage = ({
  role,
  content
}: RunInputMessage): ModelMessage => ({
  role: normalizeRole(role),
  content: content as RunMessageContent
} as ModelMessage);

const toAgentRunInput = (input: RunInput) => ({
  messages: input.messages.map(toAgentMessage),
  ...(input.context !== undefined ? { context: input.context } : {}),
  ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
  ...(input.additionalTools !== undefined ? { additionalTools: input.additionalTools } : {}),
  ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {})
});

export class RunApiService {
  constructor(private readonly agent: Agent) { }

  wait(input: RunInput): Promise<AgentRunResult> {
    return this.agent.invoke(toAgentRunInput(input));
  }

  async *stream(input: RunInput): AsyncIterable<RunAgentStreamEvent> {
    yield* this.agent.stream(toAgentRunInput(input));
  }
}
