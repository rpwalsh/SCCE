// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  base: "./",
  plugins: [react({ babel: { plugins: ["relay"] } })],
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  worker: { format: "es" },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    },
    proxy: { "/api": "http://127.0.0.1:3873" }
  },
  build: { target: "es2022", sourcemap: true, rollupOptions: { output: {
    onlyExplicitManualChunks: true,
    manualChunks(id) { if (/[/\\]react-dom(?:@|[/\\])/u.test(id)) return "react-dom"; }
  } } }
});
