import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface ExpectedFileContent {
  readonly exists: boolean;
  readonly content?: string;
}

/** Replace the file only after its complete new contents have been written. */
export async function atomicWrite(
  file: string,
  content: string,
  expected?: ExpectedFileContent,
): Promise<void> {
  // Preserve existing symlinks and executable permissions.
  const target = await fs.realpath(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return file;
    throw error;
  });
  const mode = await fs.stat(target).then(stat => stat.mode).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const temporary = path.join(path.dirname(target), `.eva-write-${randomUUID()}`);
  try {
    const handle = await fs.open(temporary, "wx", mode);
    try {
      await handle.writeFile(content, "utf8");
      if (mode !== undefined) await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (expected !== undefined) {
      const current = await fs.readFile(target, "utf8").then(
        value => ({ exists: true as const, content: value }),
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return { exists: false as const };
          throw error;
        },
      );
      if (current.exists !== expected.exists ||
        (current.exists && current.content !== expected.content)) {
        throw new Error(`${file} was modified since it was read. Re-read the file and retry.`);
      }
    }
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
