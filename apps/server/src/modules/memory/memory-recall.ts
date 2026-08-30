import { eq } from "drizzle-orm";

import { createMemoryPromptSection, type MemoryEntry } from "@eva/harness";

import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import { isVecAvailable } from "../../db/index.js";
import { MemoryEmbeddingRepository } from "./memory-embedding-repository.js";
import type { IMemoryRepository } from "./memory-repository.js";
import type { IMessageSearchRepository, MessageSearchHit } from "../search/index.js";
import { memories } from "../../db/schema.js";
import { generateEmbedding } from "./memory-embedding.js";
import { estimateTokens } from "../../lib/token-estimator.js";
import { resolveModelSlot } from "../providers/index.js";

const QUERY_REWRITE_SYSTEM_PROMPT = `You are a query rewriting assistant. Your task is to rewrite conversational user messages into concise search queries optimized for semantic memory retrieval.

Rules:
- Output ONLY the rewritten query, nothing else
- Remove filler words, greetings, and conversational noise
- Keep key entities, facts, and intent
- Use keywords and short phrases, not full sentences
- If the message is already a good search query, return it unchanged
- Output in the same language as the input`;

export interface RecallResult {
  readonly promptContext: string | undefined;
  readonly memoryEntries: readonly RecalledMemoryEntry[];
  readonly historyHits: readonly RecalledHistoryHit[];
}

export interface RecalledMemoryEntry extends MemoryEntry {
  readonly estimatedTokens: number;
}

export interface RecalledHistoryHit extends MessageSearchHit {
  readonly snippet: string;
  readonly estimatedTokens: number;
}

export interface RenderRecallPromptContextOptions {
  readonly tokenBudget: number;
}

export interface RenderRecallPromptContextResult {
  readonly promptContext: string | undefined;
  readonly usedMemoryIds: readonly string[];
  readonly usedHistoryMessageIds: readonly string[];
  readonly estimatedTokens: number;
}

export interface CalculateMemoryContextBudgetOptions {
  readonly historyTokens: number;
  readonly contextWindow?: number;
  readonly reservedOutputTokens?: number;
  readonly existingContext?: Record<string, unknown>;
}

const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;
const DEFAULT_RESERVED_OUTPUT_TOKENS = 8_000;
const MAX_MEMORY_CONTEXT_TOKENS = 8_000;
const MEMORY_CONTEXT_RATIO = 0.15;
const MAX_HISTORY_SNIPPET_CHARS = 300;

const formatMemorySection = (
  memoriesToRender: readonly MemoryEntry[]
): string | undefined => {
  if (memoriesToRender.length === 0) {
    return undefined;
  }

  const section = createMemoryPromptSection(memoriesToRender);

  if (!section) {
    return undefined;
  }

  return `## ${section.heading}\n\n${section.body}`;
};

const toHistorySnippet = (hit: MessageSearchHit): string =>
  hit.content.length > MAX_HISTORY_SNIPPET_CHARS
    ? `${hit.content.slice(0, MAX_HISTORY_SNIPPET_CHARS)}...`
    : hit.content;

const formatHistorySection = (
  historyHits: readonly RecalledHistoryHit[]
): string | undefined => {
  if (historyHits.length === 0) {
    return undefined;
  }

  const lines: string[] = [
    "## Relevant History",
    "",
    "Excerpts from past conversations that may be relevant:",
    ""
  ];

  for (const hit of historyHits) {
    lines.push(`- ${hit.snippet}`);
  }

  return lines.join("\n");
};

const composeRecallPromptContext = (
  memoryEntries: readonly MemoryEntry[],
  historyHits: readonly RecalledHistoryHit[]
): string | undefined => {
  const memorySection = formatMemorySection(memoryEntries);
  const historySection = formatHistorySection(historyHits);
  const parts = [memorySection, historySection].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );

  return parts.length > 0 ? parts.join("\n\n") : undefined;
};

const estimateContextRecordTokens = (
  context: Record<string, unknown> | undefined
): number => {
  if (!context) {
    return 0;
  }

  let total = 0;

  for (const [key, value] of Object.entries(context)) {
    total += estimateTokens(key);

    if (typeof value === "string") {
      total += estimateTokens(value);
      continue;
    }

    total += estimateTokens(JSON.stringify(value) ?? "");
  }

  return total;
};

export const calculateMemoryContextTokenBudget = (
  options: CalculateMemoryContextBudgetOptions
): number => {
  const contextWindow = options.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW;
  const reservedOutputTokens = Math.min(
    options.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS,
    DEFAULT_RESERVED_OUTPUT_TOKENS
  );
  const usedTokens =
    options.historyTokens
    + estimateContextRecordTokens(options.existingContext);
  const remainingContext = Math.max(0, contextWindow - reservedOutputTokens - usedTokens);

  return Math.max(
    0,
    Math.min(
      Math.floor(remainingContext * MEMORY_CONTEXT_RATIO),
      MAX_MEMORY_CONTEXT_TOKENS
    )
  );
};

export const renderRecallPromptContext = (
  recall: Pick<RecallResult, "memoryEntries" | "historyHits">,
  options: RenderRecallPromptContextOptions
): RenderRecallPromptContextResult => {
  const tokenBudget = Math.max(0, options.tokenBudget);

  if (tokenBudget === 0) {
    return {
      promptContext: undefined,
      usedMemoryIds: [],
      usedHistoryMessageIds: [],
      estimatedTokens: 0
    };
  }

  const selectedMemories: RecalledMemoryEntry[] = [];

  for (const memory of recall.memoryEntries) {
    const candidate = [...selectedMemories, memory];
    const promptContext = composeRecallPromptContext(candidate, []);

    if (promptContext && estimateTokens(promptContext) <= tokenBudget) {
      selectedMemories.push(memory);
    }
  }

  const selectedHistoryHits: RecalledHistoryHit[] = [];
  let currentPromptContext = composeRecallPromptContext(selectedMemories, []);

  for (const hit of recall.historyHits) {
    const candidateHits = [...selectedHistoryHits, hit];
    const candidatePromptContext = composeRecallPromptContext(
      selectedMemories,
      candidateHits
    );

    if (
      candidatePromptContext
      && estimateTokens(candidatePromptContext) <= tokenBudget
    ) {
      selectedHistoryHits.push(hit);
      currentPromptContext = candidatePromptContext;
    }
  }

  const promptContext = currentPromptContext;

  return {
    promptContext,
    usedMemoryIds: selectedMemories.map((memory) => memory.id),
    usedHistoryMessageIds: selectedHistoryHits.map((hit) => hit.messageId),
    estimatedTokens: promptContext ? estimateTokens(promptContext) : 0
  };
};

/**
 * Extract keywords from user text for lexical memory recall.
 */
const extractKeywords = (text: string, maxKeywords = 5): readonly string[] => {
  const tokens = text
    .toLowerCase()
    .split(/[\s,;.!?，。！？、：:；\-—–()\[\]{}""''\"'`]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  const unique = [...new Set(tokens)];
  unique.sort((a, b) => b.length - a.length);

  return unique.slice(0, maxKeywords);
};

/**
 * Resolve the embedding provider for semantic recall.
 * 槽位不可用 → undefined(语义检索降级为纯 FTS)。
 */
const resolveEmbeddingProvider = (db: AppDatabase, config: AppConfig) => {
  const resolved = resolveModelSlot(db, config, "embedding");
  return resolved.ok ? resolved.binding : undefined;
};

/**
 * Resolve the tool model for query rewriting。
 *
 * 只认 tool 槽位:这里拿不到会话上下文,而主对话模型是 per-thread 的(没有全局
 * chat 槽位可回落)。tool 没配 → 返回 undefined,调用方跳过改写用原始查询 ——
 * 查询改写是可降级的增强,不该为它编一个模型出来。
 */
const resolveToolModelProvider = (db: AppDatabase, config: AppConfig) => {
  const tool = resolveModelSlot(db, config, "tool");
  return tool.ok ? tool.binding : undefined;
};

/**
 * Rewrite a conversational user message into a better search query
 * using the tool model's chat completions API.
 */
const rewriteQuery = async (
  db: AppDatabase,
  config: AppConfig,
  userMessage: string
): Promise<string> => {
  const provider = resolveToolModelProvider(db, config);
  if (!provider) return userMessage;

  try {
    const response = await fetch(`${(provider.baseURL ?? "").replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: provider.modelId,
        messages: [
          { role: "system", content: QUERY_REWRITE_SYSTEM_PROMPT },
          { role: "user", content: userMessage }
        ],
        temperature: 0,
        max_tokens: 200
      })
    });

    if (!response.ok) return userMessage;

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const rewritten = json.choices?.[0]?.message?.content?.trim();
    return rewritten && rewritten.length > 0 ? rewritten : userMessage;
  } catch {
    return userMessage; // fallback to original on any error
  }
};

export interface RecallOptions {
  readonly db: AppDatabase;
  readonly config: AppConfig;
  readonly memoryRepo: IMemoryRepository;
  readonly messageSearch: IMessageSearchRepository | undefined;
  readonly userId?: string;
  readonly memoryTopK?: number;
  readonly historyTopK?: number;
  readonly similarityThreshold?: number;
  readonly queryRewriting?: boolean;
}

/**
 * Server-side recall: semantic top-k (if vec available) with lexical fallback,
 * plus FTS5 history search.
 */
export const recallMemories = async (
  userMessage: string,
  options: RecallOptions
): Promise<RecallResult> => {
  const {
    db,
    config,
    memoryRepo,
    messageSearch,
    userId = "default",
    memoryTopK = 10,
    historyTopK = 5,
    similarityThreshold = 0.4,
    queryRewriting = false
  } = options;

  // --- Query rewriting (optional) ---
  const searchQuery = queryRewriting
    ? await rewriteQuery(db, config, userMessage)
    : userMessage;

  // --- Memory recall ---
  let memoryEntries: readonly MemoryEntry[];

  const semanticResults = await trySemanticRecall(
    db, config, searchQuery, memoryRepo, userId, memoryTopK, similarityThreshold
  );

  if (semanticResults) {
    memoryEntries = semanticResults;

    // Supplement with lexical if semantic returned fewer than topK
    if (memoryEntries.length < memoryTopK) {
      const semanticIds = new Set(memoryEntries.map((e) => e.id));
      const lexical = lexicalRecall(searchQuery, memoryRepo, userId, memoryTopK);
      const supplement = lexical.filter((e) => !semanticIds.has(e.id));
      memoryEntries = [...memoryEntries, ...supplement].slice(0, memoryTopK);
    }
  } else {
    memoryEntries = lexicalRecall(searchQuery, memoryRepo, userId, memoryTopK);
  }

  // Update last_recalled_at for matched memories
  if (memoryEntries.length > 0) {
    const now = new Date().toISOString();
    for (const entry of memoryEntries) {
      db.update(memories)
        .set({ lastRecalledAt: now })
        .where(eq(memories.id, entry.id))
        .run();
    }
  }

  // --- History recall (FTS) ---
  let historyHits: readonly MessageSearchHit[] = [];
  if (messageSearch && userMessage.length >= 3) {
    try {
      historyHits = messageSearch.search(userMessage, historyTopK);
    } catch {
      // FTS table may not exist — graceful degradation
    }
  }

  const recalledMemoryEntries: readonly RecalledMemoryEntry[] = memoryEntries.map((entry) => ({
    ...entry,
    estimatedTokens: estimateTokens(entry.content)
  }));
  const recalledHistoryHits: readonly RecalledHistoryHit[] = historyHits.map((hit) => {
    const snippet = toHistorySnippet(hit);

    return {
      ...hit,
      snippet,
      estimatedTokens: estimateTokens(snippet)
    };
  });
  const rendered = renderRecallPromptContext(
    {
      memoryEntries: recalledMemoryEntries,
      historyHits: recalledHistoryHits
    },
    { tokenBudget: Number.MAX_SAFE_INTEGER }
  );

  return {
    promptContext: rendered.promptContext,
    memoryEntries: recalledMemoryEntries,
    historyHits: recalledHistoryHits
  };
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Attempt semantic recall via sqlite-vec. Returns undefined if not available.
 */
const trySemanticRecall = async (
  db: AppDatabase,
  config: AppConfig,
  userMessage: string,
  memoryRepo: IMemoryRepository,
  userId: string,
  topK: number,
  threshold: number
): Promise<readonly MemoryEntry[] | undefined> => {
  if (!isVecAvailable()) return undefined;

  const provider = resolveEmbeddingProvider(db, config);
  if (!provider) return undefined;

  try {
    const { embedding } = await generateEmbedding(provider, userMessage);
    const vecRepo = new MemoryEmbeddingRepository(db);
    const hits = vecRepo.search(embedding, topK, threshold);

    if (hits.length === 0) return undefined;

    // Resolve full memory entries
    const entries: MemoryEntry[] = [];
    for (const hit of hits) {
      const memory = memoryRepo.findById(hit.memoryId);
      if (memory && memory.userId === userId) {
        entries.push(memory);
      }
    }

    return entries.length > 0 ? entries : undefined;
  } catch {
    return undefined; // fallback to lexical
  }
};

/**
 * Lexical keyword-based recall (current behavior).
 */
const lexicalRecall = (
  userMessage: string,
  memoryRepo: IMemoryRepository,
  userId: string,
  topK: number
): readonly MemoryEntry[] => {
  const keywords = extractKeywords(userMessage);

  if (keywords.length === 0) {
    return memoryRepo.listAll(userId, topK);
  }

  const seen = new Map<string, MemoryEntry>();
  for (const keyword of keywords) {
    for (const hit of memoryRepo.search(keyword, userId, topK)) {
      if (!seen.has(hit.id)) seen.set(hit.id, hit);
    }
  }

  return seen.size > 0
    ? [...seen.values()].slice(0, topK)
    : memoryRepo.listAll(userId, topK);
};
