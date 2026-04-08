import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(scriptDir, "..");
const sourceDir = path.join(serverDir, "src", "db", "migrations");
const targetDir = path.join(serverDir, "dist", "migrations");

if (!existsSync(sourceDir)) {
  throw new Error(`Migrations source folder not found: ${sourceDir}`);
}

mkdirSync(path.dirname(targetDir), {
  recursive: true
});
cpSync(sourceDir, targetDir, {
  recursive: true,
  force: true
});
