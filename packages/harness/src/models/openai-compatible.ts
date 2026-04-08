import { ChatOpenAI } from "@langchain/openai";
import type { AIMessage, AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";

import type { AgentModel } from "./agent-model.js";
import { normalizeModelError } from "./errors.js";

export interface OpenAiCompatibleConfiguration {
  baseURL?: string;
}

export interface OpenAiCompatibleModelOptions {
  apiKey: string;
  configuration?: OpenAiCompatibleConfiguration;
  model: string;
  temperature?: number;
}

export class OpenAiCompatibleModel implements AgentModel {
  private readonly model: ChatOpenAI;

  constructor(options: OpenAiCompatibleModelOptions) {
    this.model = new ChatOpenAI({
      apiKey: options.apiKey,
      ...(options.configuration
        ? {
          configuration: options.configuration
        }
        : {}),
      model: options.model,
      temperature: options.temperature ?? 0.5
    });
  }

  async invoke(
    messages: BaseMessage[],
    tools: StructuredToolInterface[]
  ): Promise<AIMessage> {
    try {
      if (tools.length === 0) {
        return this.model.invoke(messages);
      }

      const modelWithTools = this.model.bindTools(tools, {
        tool_choice: "auto",
        parallel_tool_calls: false
      });

      return modelWithTools.invoke(messages) as Promise<AIMessage>;
    } catch (error) {
      throw normalizeModelError(error);
    }
  }

  async *stream(
    messages: BaseMessage[],
    tools: StructuredToolInterface[]
  ): AsyncIterable<AIMessageChunk> {
    try {
      if (tools.length === 0) {
        yield* await this.model.stream(messages);
        return;
      }

      const modelWithTools = this.model.bindTools(tools, {
        tool_choice: "auto",
        parallel_tool_calls: false
      });

      yield* await modelWithTools.stream(messages);
    } catch (error) {
      throw normalizeModelError(error);
    }
  }
}
