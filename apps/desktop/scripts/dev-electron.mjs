import { context } from "esbuild";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  external: ["electron"],
  sourcemap: true,
  minify: false
};

let electronProcess = null;

function startElectron() {
  if (electronProcess) {
    electronProcess.kill();
    electronProcess = null;
  }

  electronProcess = spawn("electron", ["."], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, FORCE_COLOR: "1" }
  });

  electronProcess.on("close", (code) => {
    // User closed the window normally
    if (code === 0 || code === null) {
      process.exit(0);
    }
  });
}

// Build main + preload with watch mode
const mainCtx = await context({
  ...shared,
  entryPoints: [resolve(root, "electron/main.ts")],
  outfile: resolve(root, "dist-electron/main.js"),
  plugins: [{
    name: "restart-electron",
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length === 0) {
          console.log("[dev] main.ts rebuilt, restarting electron...");
          startElectron();
        }
      });
    }
  }]
});

await context({
  ...shared,
  entryPoints: [resolve(root, "electron/preload.ts")],
  outfile: resolve(root, "dist-electron/preload.js")
}).then((ctx) => ctx.watch());

// Start watching main (triggers initial build + electron start)
await mainCtx.watch();

console.log("[dev] Watching electron files for changes...");
