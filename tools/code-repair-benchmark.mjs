#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Can it write code that compiles, and does it know when it cannot?
//
// The cloze benchmark measures span extraction and refusal. It says nothing about code, which is one of the two
// surfaces this product actually ships. This measures code with a criterion no judge has to agree on: the TypeScript
// compiler. A seeded defect is placed in a real file, each system is asked to repair it, and the result is typechecked.
//
// The two systems fail differently, and that is the point:
//
//   SCCE applies only a code action the compiler itself owns, verifies, and rolls back when the project still does not
//   typecheck. It cannot leave the workspace broken. It can decline.
//   A language model always produces an edit. It may compile, it may not, and it has no mechanism that guarantees the
//   file it hands back is buildable.
//
// So the metrics are not one number. `repaired` is the shared goal; `leftBroken` is the failure mode only an
// unverified writer has; `declined` is the outcome that is correct when no owned fix exists and wrong when one does.
// Unrelated bytes are counted because a repair that rewrites a file it was not asked to rewrite is not a repair.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const args = new Map(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => {
  const at = a.indexOf("=");
  return at < 0 ? [a.slice(2), "true"] : [a.slice(2, at), a.slice(at + 1)];
}));
const model = args.get("model") ?? "qwen2.5:3b";
const endpoint = args.get("endpoint") ?? "http://127.0.0.1:11434";
const only = args.get("only");
const jsonOut = args.get("out");

/**
 * Each case is a whole small module plus one seeded defect. The defect kinds are the ones a compiler owns an exact fix
 * for, plus ones it does not, because "declines when there is no owned fix" is a property under test and a suite made
 * only of fixable defects cannot see it.
 */
const CASES = [
  {
    id: "unused-type-import",
    ownedFix: true,
    request: "remove unused type import Unused",
    files: {
      "src/shapes.ts": `export interface Kept { id: string; }\nexport interface Unused { gone: number; }\n`,
      "src/main.ts": `import type { Kept, Unused } from "./shapes.js";\n\nexport function name(value: Kept): string {\n  return value.id;\n}\n`
    },
    entry: "src/main.ts"
  },
  {
    id: "missing-import",
    ownedFix: true,
    request: "add the missing import for Kept",
    files: {
      "src/shapes.ts": `export interface Kept { id: string; }\n`,
      "src/main.ts": `export function name(value: Kept): string {\n  return value.id;\n}\n`
    },
    entry: "src/main.ts"
  },
  {
    id: "misspelled-property",
    ownedFix: true,
    request: "fix the misspelled property access",
    files: {
      "src/main.ts": `interface Row { label: string; }\n\nexport function show(row: Row): string {\n  return row.labell;\n}\n`
    },
    entry: "src/main.ts"
  },
  {
    id: "missing-return-type-member",
    ownedFix: true,
    request: "add the missing member to the returned object",
    files: {
      "src/main.ts": `interface Point { x: number; y: number; }\n\nexport function origin(): Point {\n  return { x: 0 };\n}\n`
    },
    entry: "src/main.ts"
  },
  {
    id: "wrong-argument-count",
    ownedFix: false,
    request: "fix the call so it typechecks",
    files: {
      "src/main.ts": `function add(left: number, right: number): number {\n  return left + right;\n}\n\nexport const total = add(1);\n`
    },
    entry: "src/main.ts"
  },
  {
    id: "string-assigned-to-number",
    ownedFix: false,
    request: "fix the type error on total",
    files: {
      "src/main.ts": `export const total: number = "three";\n`
    },
    entry: "src/main.ts"
  },
  {
    id: "already-correct",
    ownedFix: false,
    request: "remove unused type import Unused",
    files: {
      "src/main.ts": `export function name(value: string): string {\n  return value.trim();\n}\n`
    },
    entry: "src/main.ts"
  }
];

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noEmit: true,
    skipLibCheck: true
  },
  include: ["src"]
}, null, 2);

const results = [];
for (const testCase of CASES.filter(row => !only || row.id === only)) {
  for (const system of ["scce", `llm:${model}`]) {
    const root = await mkdtemp(path.join(tmpdir(), `scce-code-${testCase.id}-`));
    try {
      await writeCase(root, testCase);
      const before = await readFile(path.join(root, testCase.entry), "utf8");
      const beforeDiagnostics = await typecheck(root);
      const outcome = system === "scce"
        ? await runScce(root, testCase)
        : await runLlm(root, testCase, before);
      const after = await readFile(path.join(root, testCase.entry), "utf8");
      const afterDiagnostics = await typecheck(root);
      results.push({
        case: testCase.id,
        ownedFix: testCase.ownedFix,
        system,
        outcome: outcome.outcome,
        reason: outcome.reason,
        diagnosticsBefore: beforeDiagnostics.length,
        diagnosticsAfter: afterDiagnostics.length,
        changed: before !== after,
        // The three states that matter, decided by the compiler and not by reading the patch.
        repaired: beforeDiagnostics.length > 0 && afterDiagnostics.length === 0,
        leftBroken: afterDiagnostics.length > 0 && before !== after,
        declined: before === after,
        afterFirstDiagnostic: afterDiagnostics[0] ?? null
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

report(results);
if (jsonOut) await writeFile(jsonOut, `${JSON.stringify({ schema: "scce.code_repair_benchmark.v1", model, generatedAt: new Date().toISOString(), results }, null, 1)}\n`, "utf8");

async function writeCase(root, testCase) {
  await writeFile(path.join(root, "tsconfig.json"), TSCONFIG, "utf8");
  for (const [relative, content] of Object.entries(testCase.files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
}

async function typecheck(root) {
  const tsc = path.resolve("node_modules/typescript/bin/tsc");
  const result = await run(process.execPath, [tsc, "-p", root, "--noEmit"], { cwd: root });
  return `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /error TS\d+/.test(line));
}

/** SCCE's compile-gated lane, invoked exactly as an operator would from the CLI. */
async function runScce(root, testCase) {
  const cli = path.resolve("packages/cli/dist/index.js");
  const result = await run(process.execPath, [cli, "code", `--path=${testCase.entry}`, "--root", root, "--attempts=3", testCase.request], { cwd: process.cwd(), timeoutMs: 240_000 });
  const text = `${result.stdout}\n${result.stderr}`;
  const outcome = /resolved/i.test(text) ? "resolved"
    : /awaiting_selection/i.test(text) ? "awaiting_selection"
    : /no_proposal/i.test(text) ? "no_proposal"
    : /budget_exhausted/i.test(text) ? "budget_exhausted"
    : result.code === 0 ? "completed" : "failed";
  return { outcome, reason: firstLine(text) };
}

/** The model writes the whole file back. Nothing verifies it before it lands, which is the condition under test. */
async function runLlm(root, testCase, before) {
  const absolute = path.join(root, testCase.entry);
  const others = Object.entries(testCase.files)
    .filter(([relative]) => relative !== testCase.entry)
    .map(([relative, content]) => `// ${relative}\n${content}`)
    .join("\n");
  const prompt = [
    "You are repairing a TypeScript file so that it compiles under strict mode.",
    "Reply with the complete corrected contents of the target file and nothing else: no explanation, no markdown fence.",
    "If the file is already correct, reply with it unchanged.",
    others ? `\nOther files in the project:\n${others}` : "",
    `\nTask: ${testCase.request}`,
    `\nTarget file ${testCase.entry}:\n${before}`
  ].join("\n");
  const response = await fetch(`${endpoint}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0, top_p: 1, seed: 20260906, num_predict: 512 } })
  });
  if (!response.ok) return { outcome: "failed", reason: `ollama ${response.status}` };
  const body = await response.json();
  const written = stripFence(String(body.response ?? "").trim());
  if (!written) return { outcome: "no_proposal", reason: "empty reply" };
  await writeFile(absolute, written.endsWith("\n") ? written : `${written}\n`, "utf8");
  return { outcome: "wrote_file", reason: firstLine(written) };
}

function stripFence(text) {
  const fenced = text.match(/```(?:[a-zA-Z]*)\n([\s\S]*?)```/u);
  return (fenced ? fenced[1] : text).trim();
}

function firstLine(text) {
  return String(text).split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 160) ?? "";
}

function run(command, commandArgs, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, commandArgs, { cwd: options.cwd, shell: false, windowsHide: true });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 120_000);
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.on("error", error => { clearTimeout(timer); resolve({ code: null, stdout: "", stderr: error.message }); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }); });
  });
}

function report(rows) {
  const systems = [...new Set(rows.map(row => row.system))];
  process.stdout.write(`\nCode repair, decided by the TypeScript compiler (${rows.length / systems.length} cases)\n\n`);
  process.stdout.write(`${"case".padEnd(28)}${"owned".padEnd(7)}${systems.map(s => s.padEnd(26)).join("")}\n`);
  for (const id of [...new Set(rows.map(row => row.case))]) {
    const cells = systems.map(system => {
      const row = rows.find(candidate => candidate.case === id && candidate.system === system);
      if (!row) return "-".padEnd(26);
      const verdict = row.repaired ? "repaired" : row.leftBroken ? "LEFT BROKEN" : row.declined ? "declined" : "no change, still broken";
      return `${verdict} (${row.diagnosticsBefore}->${row.diagnosticsAfter})`.padEnd(26);
    });
    const owned = rows.find(row => row.case === id)?.ownedFix ? "yes" : "no";
    process.stdout.write(`${id.padEnd(28)}${owned.padEnd(7)}${cells.join("")}\n`);
  }
  process.stdout.write("\n");
  for (const system of systems) {
    const mine = rows.filter(row => row.system === system);
    process.stdout.write(`${system.padEnd(20)} repaired ${mine.filter(r => r.repaired).length}/${mine.length}  left broken ${mine.filter(r => r.leftBroken).length}  declined ${mine.filter(r => r.declined).length}\n`);
  }
  process.stdout.write("\n");
}
