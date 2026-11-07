// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { defineConfig } from "vitest/config";

const heapMb = Number(process.env.SCCE_MCP_TEST_HEAP_MB ?? 512);
if (!Number.isSafeInteger(heapMb) || heapMb <= 0) throw new Error("SCCE_MCP_TEST_HEAP_MB must be a positive integer");

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true, execArgv: [`--max-old-space-size=${heapMb}`] } },
    testTimeout: 60000,
    hookTimeout: 60000
  }
});
