import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const testHeapMb = Number(process.env.SCCE_TEST_HEAP_MB ?? 8192);
if (!Number.isSafeInteger(testHeapMb) || testHeapMb <= 0) throw new Error("SCCE_TEST_HEAP_MB must be a positive integer");

export default defineConfig({
  resolve: { alias: [{ find: /^@scce\/kernel$/u, replacement: fileURLToPath(new URL("./packages/kernel/src/index.ts", import.meta.url)) }] },
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
        // Confirmed live: even 6144 still OOM'd on some shard compositions
        // (--logHeapUsage showed each individual file's live heap staying
        // under ~200MB, so this is allocation-rate/GC-pause pressure from
        // real heavy computation -- e.g. genuine TypeScript compiler
        // Program/LanguageService construction -- not a slow cross-file
        // leak). Shards run strictly sequentially (one forked process
        // alive at a time, never concurrent) on a 16GB machine, so there
        // is real headroom to raise this further.
        execArgv: [`--max-old-space-size=${testHeapMb}`]
      }
    }
  }
});
