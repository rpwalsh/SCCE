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

// Confirmed live: 6 shards still OOM'd on a shard that happened to combine
// several of the repo's heaviest test files (graph-surface-alignment-
// training + workspace-runtime-compiler-planning). More, smaller shards
// lowers the odds any one shard's sequential heap accumulation lands two
// or more heavy files together; combined with vitest.config.ts's raised
// 6144MB cap, this cleared the previously-OOMing combination.
const SHARD_COUNT = Number.parseInt(process.env.SCCE_TEST_SHARDS ?? "10", 10);
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
