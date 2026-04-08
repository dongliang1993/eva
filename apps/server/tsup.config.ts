import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  clean: true,
  dts: false,
  external: ["better-sqlite3", "fast-glob", "fastify", "zod", /^@langchain\//, /^@fastify\//, /^drizzle-/],
  format: ["esm"],
  noExternal: [/^@eva\//],
  outDir: "dist",
  platform: "node",
  sourcemap: true,
  target: "node22"
});
