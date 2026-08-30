import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DAILY_NOTE_DAYS,
  loadMemoryFilesSection
} from "../../../apps/server/src/modules/memory/index.js";

const tempDirs: string[] = [];

const createTempRoot = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "eva-memsect-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

const fileName = (root: string, rel: string): string => path.join(root, rel);

/** 相对"今天"偏移 days 天的日期;0 = 今天,1 = 昨天。 */
const dateForAgo = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

describe("loadMemoryFilesSection", () => {
  it("returns undefined when neither MEMORY.md nor notes exist", async () => {
    const root = await createTempRoot();
    expect(await loadMemoryFilesSection(root, "2026-08-19")).toBeUndefined();
  });

  it("includes only MEMORY.md when no notes exist", async () => {
    const root = await createTempRoot();
    const content = "饮食偏好:喜欢汉堡";
    await writeFile(fileName(root, "MEMORY.md"), content, "utf-8");

    const section = (await loadMemoryFilesSection(root, dateForAgo(0)))!;
    expect(section).toBeDefined();
    expect(section.heading).toBe("Memory Files");
    expect(section.body).toContain("### MEMORY.md");
    expect(section.body).toContain(content);
    expect(section.body).not.toContain("### memory/");
  });

  it("injects MEMORY.md plus recent notes, newest first", async () => {
    const root = await createTempRoot();
    await writeFile(fileName(root, "MEMORY.md"), "long term", "utf-8");
    await mkdir(fileName(root, "memory"), { recursive: true });

    const today = dateForAgo(0);
    const yesterday = dateForAgo(1);
    await writeFile(fileName(root, `memory/${today}.md`), "today note", "utf-8");
    await writeFile(fileName(root, `memory/${yesterday}.md`), "yesterday note", "utf-8");

    const body = (await loadMemoryFilesSection(root, today))!.body;
    expect(body.indexOf(`### memory/${yesterday}.md`)).toBeGreaterThan(
      body.indexOf(`### memory/${today}.md`)
    );
  });

  it(`only injects the last ${"DAILY_NOTE_DAYS"} days`, async () => {
    const root = await createTempRoot();
    await mkdir(fileName(root, "memory"), { recursive: true });

    const today = dateForAgo(0);
    const old = dateForAgo(DAILY_NOTE_DAYS + 1);
    await writeFile(fileName(root, `memory/${today}.md`), "today", "utf-8");
    await writeFile(fileName(root, `memory/${old}.md`), "too old", "utf-8");

    const body = (await loadMemoryFilesSection(root, today))!.body;
    expect(body).toContain(`memory/${today}.md`);
    expect(body).not.toContain(`memory/${old}.md`);
  });

  it("truncates an oversized MEMORY.md with a marker", async () => {
    const root = await createTempRoot();
    await writeFile(fileName(root, "MEMORY.md"), "x".repeat(9 * 1024), "utf-8");

    const body = (await loadMemoryFilesSection(root, dateForAgo(0)))!.body;
    expect(body).toContain("[truncated");
  });
});
