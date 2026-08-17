import { z } from "zod";

// Loose role enum: accepts legacy LangChain roles (human/ai/function/generic/remove)
// from older clients at the API boundary, normalized to Vercel ModelMessage roles
// in services/runs.ts before reaching the agent.
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

// Content block shape compatible with Vercel AI SDK prompt parts.
// Kept permissive (passthrough) so provider-specific part fields survive.
const runMessageContentBlockSchema = z.object({}).passthrough();

export const runMessageContentSchema = z.union([
  z.string(),
  z.array(runMessageContentBlockSchema)
]);

export type RunMessageContent = z.infer<typeof runMessageContentSchema>;

export interface RunInputMessage extends Record<string, unknown> {
  role: RunMessageRole;
  content: RunMessageContent;
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
  abortSignal?: AbortSignal;
}
