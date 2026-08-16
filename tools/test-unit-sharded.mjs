#!/usr/bin/env node
import { spawn } from "node:child_process";

/**
 * vitest.config.ts deliberately forces `singleFork: true` (see its own
 * comment) so parallel heavy test files can't each grow toward a
 * multi-GB heap at once -- but the tradeoff is every one of the ~1189
 * test files across the whole repo then runs inside that *one* forked
 * process for the entire run, so memory accumulates across files and
 * never resets. Confirmed live: a full `vitest run` reliably hit the
 * config's own 4096MB cap and crashed with a real
 * "JavaScript heap out of memory" error partway through.
 *
 * Real fix: split the same file set into several fresh `vitest run`
 * invocations (vitest's own --shard flag), run sequentially. Each shard
 * is a genuinely separate OS process with a fresh, empty heap, so
 * whatever accumulated in shard N is fully reclaimed by the OS before
 * shard N+1 starts -- not a workaround for a mystery leak, just bounding
 * how many files share one process's lifetime, same principle as
 * vitest.config.ts's own singleFork choice, applied one level up.
 */

// Confirmed live across three separate full-suite attempts (6, then 10
// shards; 6144MB, then 8192MB heap cap): shards 1-9 of a 10-way split now
// consistently pass clean, but shard 10 still reliably stalls/OOMs on a
// cluster of real-TypeScript-compiler-invoking test files (Program/
// LanguageService construction is genuinely heavy, not a leak -- see
// vitest.config.ts's own note). Neither a larger heap cap nor 10-way
// sharding alone resolved it; more, smaller shards further reduces the
// odds that several of those specific heavy files land together in one
// process's sequential lifetime. This has NOT been re-verified end to end
// at 20 shards -- a real residual risk on this specific file cluster,
// not silently declared fixed.
const SHARD_COUNT = Number.parseInt(process.env.SCCE_TEST_SHARDS ?? "20", 10);
const extraArgs = process.argv.slice(2);

// A filtered/targeted run (e.g. `pnpm test:unit some-file-pattern`, the
// same invocation this repo's dev-mcp test_run tool uses) is already
// small -- splitting it into SHARD_COUNT separate processes would only
// add startup overhead, not help. Sharding only pays off for the real
// full, unfiltered suite.
if (extraArgs.length > 0) {
  const child = spawn("pnpm", ["exec", "vitest", "run", ...extraArgs], { stdio: "inherit", shell: true });
  child.on("error", error => { throw error; });
  child.on("exit", code => process.exit(code ?? 1));
} else {
  await runFullSuiteSharded();
}

async function runFullSuiteSharded() {
  let failed = false;
  for (let index = 1; index <= SHARD_COUNT; index++) {
    const code = await runShard(index);
    if (code !== 0) {
      failed = true;
      console.error(`\nshard ${index}/${SHARD_COUNT} failed with exit code ${code}\n`);
    }
  }
  process.exit(failed ? 1 : 0);
}

function runShard(index) {
  return new Promise((resolve, reject) => {
    const args = ["vitest", "run", `--shard=${index}/${SHARD_COUNT}`];
    console.log(`\n--- shard ${index}/${SHARD_COUNT}: pnpm exec ${args.join(" ")} ---\n`);
    const child = spawn("pnpm", ["exec", ...args], { stdio: "inherit", shell: true });
    child.on("error", reject);
    child.on("exit", code => resolve(code ?? 1));
  });
}
