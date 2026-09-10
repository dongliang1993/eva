import { createRunLoopAgent } from "./run-loop.js";
import type { Agent, CreateAgentOptions } from "./types.js";

/** Create reusable configuration; execution state and tools are assembled per run. */
export const createAgent = (options: CreateAgentOptions): Agent => createRunLoopAgent(options);
