#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Can it repair its own source?
//
// The seeded-defect suite measures the lane against seven files written to exercise it. This measures it against
// this project's own code: real modules, hundreds of lines each, with a defect introduced by a deterministic
// mutation and the real TypeScript compiler deciding whether it was repaired.
//
// The criterion here is sharper than "it compiles", because for a mutation the original text is known. `exact`
// means the repair restored the file byte for byte -- it recovered the code that was there, not merely some code
// the compiler accepts. `compiles` is the weaker outcome and is reported separately, because a file that builds
// while saying something else is not a repair and the difference has to stay visible.
//
// Nothing here is scored by reading a patch. The compiler decides validity, byte equality decides correctness,
// and the lane's own rollback decides that a failed attempt costs nothing.
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const adapters = await import(pathToFileURL(path.resolve("packages/adapters-node/dist/index.js")).href);
const { createLearnedCodeProposer, createTypeScriptCodeMouthPorts, readScceRuntimeConfig, createNodeRuntime, runCodeMouth, diagnosticsForTarget } = adapters;

const args = new Map(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => {
  const at = a.indexOf("=");
  return at < 0 ? [a.slice(2), "true"] : [a.slice(2, at), a.slice(at + 1)];
}));
const sourceDir = path.resolve(args.get("dir") ?? "packages/kernel/src");
const maxFiles = Number(args.get("files") ?? 8);
const attempts = Number(args.get("attempts") ?? 3);
const outPath = args.get("out");
const only = args.get("only");

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true
  },
  include: ["src"]
}, null, 2);

/**
 * Mutations that produce a defect a compiler can see, each the inverse of a repair the lane claims to make.
 *
 * A mutation is only used when it actually breaks the build: applying one that type-checks anyway would measure
 * the lane against a file with nothing wrong with it, and score its correct refusal as a failure.
 */
const MUTATIONS = [
  {
    id: "misspell-reference",
    describe: "transpose two characters in one use of a name declared elsewhere in the file",
    apply(text) {
      for (const match of [...text.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]{4,})\b/gu)].reverse()) {
        const name = match[1];
        const occurrences = [...text.matchAll(new RegExp(`\\b${name}\\b`, "gu"))];
        if (occurrences.length < 3) continue;
        const target = occurrences[occurrences.length - 1];
        const transposed = transpose(name);
        if (!transposed || text.includes(transposed)) continue;
        return {
          text: `${text.slice(0, target.index)}${transposed}${text.slice(target.index + name.length)}`,
          detail: `${name} -> ${transposed}`
        };
      }
      return undefined;
    }
  },
  {
    id: "misspell-member",
    describe: "transpose two characters in a property access",
    apply(text) {
      for (const match of [...text.matchAll(/\.([a-z][A-Za-z0-9_$]{4,})\b/gu)].reverse()) {
        const name = match[1];
        const transposed = transpose(name);
        if (!transposed || text.includes(transposed)) continue;
        const at = match.index + 1;
        return {
          text: `${text.slice(0, at)}${transposed}${text.slice(at + name.length)}`,
          detail: `.${name} -> .${transposed}`
        };
      }
      return undefined;
    }
  },
  {
    id: "three-misspellings",
    describe: "transpose characters in three separate uses, so no single edit can finish the file",
    apply(text) {
      let current = text;
      const details = [];
      for (const pattern of [/[.]([a-z][A-Za-z0-9_$]{5,})\b/gu, /\b([A-Za-z_$][A-Za-z0-9_$]{5,})\b/gu]) {
        for (const match of [...current.matchAll(pattern)].reverse()) {
          if (details.length >= 3) break;
          const name = match[1];
          const transposed = transpose(name);
          if (!transposed || current.includes(transposed)) continue;
          const at = match.index + (match[0].startsWith(".") ? 1 : 0);
          current = `${current.slice(0, at)}${transposed}${current.slice(at + name.length)}`;
          details.push(`${name}->${transposed}`);
        }
      }
      return details.length === 3 ? { text: current, detail: details.join(", ") } : undefined;
    }
  },
  {
    id: "drop-argument",
    describe: "remove the last argument of a two-argument call",
    apply(text) {
      for (const match of [...text.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\(([A-Za-z0-9_$.]+), ([A-Za-z0-9_$."']+)\)/gu)].reverse()) {
        const replacement = `${match[1]}(${match[2]})`;
        return {
          text: `${text.slice(0, match.index)}${replacement}${text.slice(match.index + match[0].length)}`,
          detail: `${match[0]} -> ${replacement}`
        };
      }
      return undefined;
    }
  }
];

/** One character pair swapped: the commonest real typo, and never a name the file already uses. */
function transpose(name) {
  for (let index = 1; index < name.length - 1; index++) {
    if (name[index] === name[index + 1]) continue;
    return `${name.slice(0, index)}${name[index + 1]}${name[index]}${name.slice(index + 2)}`;
  }
  return undefined;
}

const config = await readScceRuntimeConfig(args.get("config") ?? "scce.config.json");
const runtime = createNodeRuntime(config);
const files = (await selfContainedSources(sourceDir)).slice(0, maxFiles);
process.stdout.write(`${files.length} self-contained modules from ${sourceDir}\n\n`);

const results = [];
for (const file of files) {
  for (const mutation of MUTATIONS.filter(row => !only || row.id === only)) {
    const mutated = mutation.apply(file.text);
    if (!mutated) {
      results.push({ file: file.name, mutation: mutation.id, outcome: "not_applicable", detail: null, compiles: false, exact: false });
      continue;
    }
    const root = await mkdtemp(path.join(tmpdir(), "scce-self-"));
    try {
      await writeFile(path.join(root, "tsconfig.json"), TSCONFIG, "utf8");
      await mkdir(path.join(root, "src"), { recursive: true });
      // The file is repaired inside a project, not alone in a directory.
      //
      // A single-file workspace is not the situation a repair happens in and it hides half the system: shapes are
      // induced from what a project's own code recurs on, and one file cannot attest that anything recurs. Every
      // other module goes in beside the mutated one, which is both more realistic and the only way the
      // construction lane is exercised at all.
      for (const sibling of files) {
        await writeFile(path.join(root, "src", sibling.name), sibling.name === file.name ? mutated.text : sibling.text, "utf8");
      }
      const target = path.join("src", file.name);

      const ports = createTypeScriptCodeMouthPorts({
        workspaceRoot: root,
        learnedProposer: createLearnedCodeProposer({
          storage: runtime.storage,
          workspaceRoot: root,
          ...(args.has("log") ? { log: message => process.stdout.write(`   [lane] ${message}
`) } : {})
        }),
        ...(args.has("log") ? { log: message => process.stdout.write(`   [port] ${message}
`) } : {})
      });
      // Only the mutated file's diagnostics are this measurement's.
      //
      // The project holds every module now, and a module that does not typecheck standalone under this bare
      // tsconfig contributes errors that were there before the mutation and have nothing to do with the repair.
      // Counting those scored six byte-exact restorations as files left broken.
      const before = { diagnostics: diagnosticsForTarget((await ports.verify(target)).diagnostics, target) };
      if (!before.diagnostics.length) {
        // The mutation did not break the build, so there is nothing here to repair and nothing to score.
        results.push({ file: file.name, mutation: mutation.id, outcome: "no_defect", detail: mutated.detail, compiles: true, exact: false });
        continue;
      }
      // Attempts scale with what is wrong: converging on three defects needs at least three accepted steps.
      const budget = Math.max(attempts, before.diagnostics.length * 3);
      const result = await runCodeMouth({ request: `repair ${file.name}`, targetPath: target, maxAttempts: budget, ports });
      const after = await readFile(path.join(root, target), "utf8");
      const diagnostics = diagnosticsForTarget((await ports.verify(target)).diagnostics, target);
      results.push({
        file: file.name,
        mutation: mutation.id,
        detail: mutated.detail,
        outcome: result.outcome,
        proposalSources: result.proposalSources ?? [],
        diagnosticsBefore: before.diagnostics.length,
        diagnosticsAfter: diagnostics.length,
        compiles: diagnostics.length === 0,
        exact: after === file.text,
        changed: after !== mutated.text,
        // What it wrote, against what was there. A repair that compiles but says something else has to be
        // readable as such, or "compiles" quietly becomes the whole standard.
        wrote: firstDifference(file.text, after)
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

report(results);
if (outPath) {
  await writeFile(outPath, `${JSON.stringify({
    schema: "scce.self_repair_benchmark.v1",
    generatedAt: new Date().toISOString(),
    sourceDir,
    attempts,
    results
  }, null, 1)}\n`, "utf8");
  process.stdout.write(`\nwrote ${outPath}\n`);
}
process.exit(0);

/** The first line that differs, as it was and as it now reads. */
function firstDifference(original, current) {
  const before = original.split(/\r?\n/u);
  const after = current.split(/\r?\n/u);
  for (let index = 0; index < Math.max(before.length, after.length); index++) {
    if (before[index] === after[index]) continue;
    return { line: index + 1, was: (before[index] ?? "").trim(), now: (after[index] ?? "").trim() };
  }
  return null;
}

/** Modules that typecheck on their own, so a defect in one is measured against that module and nothing else. */
async function selfContainedSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
    const text = await readFile(path.join(directory, entry.name), "utf8");
    if (/from "\.\//u.test(text)) continue;
    if (/^import /mu.test(text)) continue;
    if (text.split("\n").length < 100) continue;
    out.push({ name: entry.name, text });
  }
  return out.sort((left, right) => left.name.localeCompare(right.name));
}

function report(rows) {
  const scored = rows.filter(row => row.outcome !== "not_applicable" && row.outcome !== "no_defect");
  process.stdout.write(`Repairing this project's own source, decided by the TypeScript compiler\n\n`);
  process.stdout.write(`${"module".padEnd(34)}${"mutation".padEnd(20)}${"outcome".padEnd(20)}result\n`);
  for (const row of rows) {
    const verdict = row.outcome === "not_applicable" || row.outcome === "no_defect"
      ? "-"
      : row.exact ? "EXACT" : row.compiles ? "compiles, different" : "unrepaired";
    process.stdout.write(`${row.file.padEnd(34)}${row.mutation.padEnd(20)}${String(row.outcome).padEnd(20)}${verdict}\n`);
    if (row.compiles && !row.exact && row.wrote) {
      process.stdout.write(`${" ".repeat(34)}  was: ${row.wrote.was.slice(0, 96)}\n`);
      process.stdout.write(`${" ".repeat(34)}  now: ${row.wrote.now.slice(0, 96)}\n`);
    }
  }
  const exact = scored.filter(row => row.exact).length;
  const compiles = scored.filter(row => row.compiles).length;
  const broken = scored.filter(row => row.changed && !row.compiles).length;
  process.stdout.write(`\n${scored.length} real defects: ${exact} restored exactly, ${compiles} compile, ${broken} left broken\n`);
}
