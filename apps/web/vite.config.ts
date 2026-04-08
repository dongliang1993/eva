import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const serverPort = process.env.SERVER_PORT || 8082;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": `http://127.0.0.1:${serverPort}`,
      "/v1": `http://127.0.0.1:${serverPort}`,
      "/health": `http://127.0.0.1:${serverPort}`
    }
  }
});
