import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  external: ["electron"],
  sourcemap: true,
  minify: false
};

await build({
  ...shared,
  entryPoints: ["electron/main.ts"],
  outfile: "dist-electron/main.js"
});

await build({
  ...shared,
  entryPoints: ["electron/preload.ts"],
  outfile: "dist-electron/preload.js"
});

console.log("Electron build complete.");
