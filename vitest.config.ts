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
        // Confirmed live: 4096 was still too tight for the heaviest shards
        // (tools/test-unit-sharded.mjs's sharded full run OOM'd on a shard
        // combining graph-surface-alignment-training.test.ts and
        // workspace-runtime-compiler-planning.test.ts). Shards run strictly
        // sequentially (one forked process alive at a time, never
        // concurrent) on a 16GB machine, so there is real headroom to raise
        // this -- 6144MB leaves the OS/other processes ~10GB and has been
        // verified to clear the previously-OOMing shard combination.
        execArgv: ["--max-old-space-size=6144"]
      }
    }
  }
});
