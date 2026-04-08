import type { BaseMessageLike } from "@langchain/core/messages";
import type {
  AgentRunResult,
  AgentStreamEvent,
} from "@eva/harness";

import type { AgentResolver } from "../agent.js";
import { AgentUnavailableError } from "../agent.js";
import type { RunInputMessage, RunInput } from "../types/runs.js";

const toAgentMessage = ({
  role,
  content,
  name,
  ...rest
}: RunInputMessage): BaseMessageLike => ({
  role,
  content,
  ...rest,
  ...(name !== undefined ? { name } : {})
});

const toAgentRunInput = (input: RunInput) => ({
  messages: input.messages.map(toAgentMessage),
  ...(input.context !== undefined ? { context: input.context } : {}),
  ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
  ...(input.additionalTools !== undefined ? { additionalTools: input.additionalTools } : {})
});

export class RunApiService {
  constructor(private readonly resolveAgent: AgentResolver | undefined) { }

  private getAgent(input: RunInput) {
    if (!this.resolveAgent) {
      throw new AgentUnavailableError();
    }

    return this.resolveAgent({
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {})
    });
  }

  wait(input: RunInput): Promise<AgentRunResult> {
    return this.getAgent(input).invoke(toAgentRunInput(input));
  }

  async *stream(input: RunInput): AsyncIterable<AgentStreamEvent> {
    yield* this.getAgent(input).stream(toAgentRunInput(input));
  }
}
