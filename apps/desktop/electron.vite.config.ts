import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

// eva desktop: 只迁 main + preload 到 electron-vite（renderer 仍是独立的 @eva/web）。
// dev 时 main.ts 连 localhost:5173（web 的 Vite），prod 时连 server 静态服务——
// 所以这里不配 renderer target。
//
// 产物路径保持 dist-electron/{main,preload}.js（与原 esbuild 脚本一致），
// main.ts 的 preload 引用（path.join(__dirname, "preload.js")）和
// package.json 的 main 字段都无需改。
//
// electron-vite 5: externalizeDepsPlugin() 已废弃，改用 build.externalizeDeps。
export default defineConfig({
  main: {
    build: {
      outDir: "dist-electron",
      emptyOutDir: false,
      lib: {
        entry: resolve(__dirname, "electron/main.ts"),
        fileName: () => "main.js",
        formats: ["cjs"]
      },
      rollupOptions: {
        external: ["electron"]
      },
      // externalizeDeps 默认把所有 package.json 依赖都 external——但打包时 files 排除了
      // node_modules,external 的依赖在 app.asar 里 require 不到(Cannot find module)。
      // electron-updater 是纯 JS(无原生模块),bundle 进 main.js 即可,故从 external 排除。
      externalizeDeps: {
        exclude: ["electron-updater"]
      }
    }
  },
  preload: {
    build: {
      outDir: "dist-electron",
      emptyOutDir: false,
      lib: {
        entry: resolve(__dirname, "electron/preload.ts"),
        fileName: () => "preload.js",
        formats: ["cjs"]
      },
      rollupOptions: {
        external: ["electron"]
      },
      externalizeDeps: true
    }
  }
});
