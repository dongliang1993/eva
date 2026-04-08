import type { AIMessage, AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";

export interface AgentModel {
  invoke(
    messages: BaseMessage[],
    tools: StructuredToolInterface[]
  ): Promise<AIMessage>;

  stream(
    messages: BaseMessage[],
    tools: StructuredToolInterface[]
  ): AsyncIterable<AIMessageChunk>;
}
