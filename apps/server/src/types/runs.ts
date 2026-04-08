import type {
  MessageContent,
  MessageContentComplex
} from "@langchain/core/messages";
import { z } from "zod";

export const runMessageRoleSchema = z.enum([
  "user",
  "assistant",
  "system",
  "developer",
  "tool",
  "human",
  "ai",
  "function",
  "generic",
  "remove"
]);

export type RunMessageRole = z.infer<typeof runMessageRoleSchema>;

const runMessageContentBlockSchema: z.ZodType<MessageContentComplex> = z
  .object({})
  .passthrough();

export const runMessageContentSchema: z.ZodType<MessageContent> = z.union([
  z.string(),
  z.array(runMessageContentBlockSchema)
]);

export interface RunInputMessage extends Record<string, unknown> {
  role: RunMessageRole;
  content: MessageContent;
  name?: string | undefined;
}

export const runMessageSchema: z.ZodType<RunInputMessage> = z
  .object({
    role: runMessageRoleSchema,
    content: runMessageContentSchema,
    name: z.string().optional()
  })
  .passthrough();

export const runSchema = z.object({
  messages: z.array(runMessageSchema).min(1),
  context: z.record(z.unknown()).optional(),
  maxSteps: z.coerce.number().int().positive().max(12).optional(),
  sessionId: z.string().optional(),
  modelId: z.string().optional()
});

type RunSchemaData = z.infer<typeof runSchema>;

import type { AgentTool } from "@eva/harness";

export interface RunInput {
  messages: RunInputMessage[];
  context?: RunSchemaData["context"];
  maxSteps?: RunSchemaData["maxSteps"];
  modelId?: RunSchemaData["modelId"];
  additionalTools?: AgentTool[];
}
