import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { PromptSection } from "./prompt-builder.js";

const SOUL_FILENAME = "SOUL.md";

/**
 * Load a SOUL.md file from the given directory and return its content.
 *
 * @param baseDir - Directory containing the SOUL.md file.
 * @returns The trimmed file content, or `undefined` if the file does not exist or is empty.
 */
export const loadSoul = async (baseDir: string): Promise<string | undefined> => {
  const soulPath = resolve(baseDir, SOUL_FILENAME);
  try {
    const content = await readFile(soulPath, "utf-8");
    const trimmed = content.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Load SOUL.md and convert it to a PromptSection for injection into the system prompt.
 *
 * @param baseDir - Directory containing the SOUL.md file.
 * @returns A PromptSection wrapping the soul content, or `undefined` if no SOUL.md found.
 */
export const loadSoulSection = async (
  baseDir: string
): Promise<PromptSection | undefined> => {
  const soul = await loadSoul(baseDir);
  if (!soul) {
    return undefined;
  }
  return { heading: "Soul", body: soul };
};
