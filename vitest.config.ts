import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
    // Default pool spawns one worker thread per CPU core with no heap cap,
    // so parallel heavy test files (e.g. graph-surface-alignment-training,
    // corpus-training) each grow toward multi-GB heaps at once and blow
    // past the environment's fixed memory ceiling. Forcing everything
    // through a single forked process with an explicit heap cap keeps
    // total memory bounded and predictable regardless of how many heavy
    // files run in a given invocation.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
        execArgv: ["--max-old-space-size=4096"]
      }
    }
  }
});
