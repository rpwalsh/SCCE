#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// What order should a code corpus be trained at, and how much should the corpus outweigh the file being edited?
//
// Both numbers govern the learned code lane and neither can be chosen by taste. They are measured here against
// the condition the lane actually runs in: a line is removed from a file, the rest of that file trains the local
// model, other files train the corpus mixture, and the measurement is how well the pair predicts the line that
// was removed, given what precedes it. That is the same question the generator answers at repair time, so the
// minimum of this sweep is the setting the generator should carry.
//
// Reported as mean negative log probability per symbol -- log perplexity. Lower is better, and the units are
// nats per code token, so a difference of 1.0 is a factor of e in how surprised the model is by real code.
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const kernel = await import(pathToFileURL(path.resolve("packages/kernel/dist/index.js")).href);
const { codeSurfaceTokens, trainKneserNey, kneserNeyProbability, CODE_LINE_SYMBOL } = kernel;

const args = new Map(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => {
  const at = a.indexOf("=");
  return at < 0 ? [a.slice(2), "true"] : [a.slice(2, at), a.slice(at + 1)];
}));
const root = path.resolve(args.get("root") ?? "packages/kernel/src");
const extension = args.get("ext") ?? ".ts";
const maxFiles = Number(args.get("files") ?? 60);
const heldOutFiles = Number(args.get("heldout") ?? 12);
const linesPerFile = Number(args.get("lines") ?? 8);
const outPath = args.get("out") ?? "tools/code-generation-calibration/report.json";

const LOCAL_MODELS = new Map();
function localModelCache(order) {
  return (filePath, index, build) => {
    const key = `${order}\u0001${filePath}\u0001${index}`;
    const cached = LOCAL_MODELS.get(key);
    if (cached) return cached;
    const model = build();
    LOCAL_MODELS.set(key, model);
    return model;
  };
}

const ORDERS = [2, 3, 4, 5, 6];
const WEIGHTS = [0, 0.15, 0.3, 0.45, 0.55, 0.65, 0.75, 0.85, 1];
/** Same mixture bound the generator uses, so the sweep measures the configuration that actually ships. */
const CORPUS_MIXTURE_LIMIT = 12;
const CONTEXT_SYMBOLS = 48;

const files = (await collectFiles(root, extension)).slice(0, maxFiles);
if (files.length < heldOutFiles + 4) {
  process.stderr.write(`need at least ${heldOutFiles + 4} ${extension} files under ${root}; found ${files.length}\n`);
  process.exit(1);
}
// Deterministic split by path so a re-run measures the same thing.
const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
const heldOut = sorted.filter((_, index) => index % Math.ceil(sorted.length / heldOutFiles) === 0).slice(0, heldOutFiles);
const heldOutPaths = new Set(heldOut.map(file => file.path));
const train = sorted.filter(file => !heldOutPaths.has(file.path));

process.stdout.write(`corpus ${train.length} files, held out ${heldOut.length}, ${linesPerFile} lines each\n\n`);

const rows = [];
for (const order of ORDERS) {
  const corpusModels = train
    .map(file => trainKneserNey(codeSurfaceTokens(file.text), { order, discount: 0.75, vocabularyLimit: 8192 }))
    .slice(0, CORPUS_MIXTURE_LIMIT);
  for (const weight of WEIGHTS) {
    const measurement = measure({ corpusModels, order, weight });
    rows.push({ order, weight, ...measurement });
    process.stdout.write(`order ${order}  weight ${weight.toFixed(2)}  log-perplexity ${measurement.logPerplexity.toFixed(4)}  covered ${(measurement.coverage * 100).toFixed(1)}%  (${measurement.symbols} symbols)\n`);
  }
  process.stdout.write("\n");
}

const best = [...rows].sort((a, b) => a.logPerplexity - b.logPerplexity)[0];
const bestByOrder = ORDERS.map(order => [...rows].filter(row => row.order === order).sort((a, b) => a.logPerplexity - b.logPerplexity)[0]);

process.stdout.write("best weight at each order\n");
for (const row of bestByOrder) {
  process.stdout.write(`  order ${row.order}: weight ${row.weight.toFixed(2)}, log-perplexity ${row.logPerplexity.toFixed(4)}\n`);
}
process.stdout.write(`\nminimum: order ${best.order}, corpus weight ${best.weight.toFixed(2)}, log-perplexity ${best.logPerplexity.toFixed(4)}\n`);

const bigram = bestByOrder.find(row => row.order === 2);
process.stdout.write(`order 2 costs ${(bigram.logPerplexity - best.logPerplexity).toFixed(4)} nats per token against the minimum (${(Math.exp(bigram.logPerplexity - best.logPerplexity)).toFixed(2)}x the perplexity)\n`);

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify({
  schema: "scce.code_generation_calibration.v1",
  generatedAt: new Date().toISOString(),
  // Repo-relative, so a committed report never carries the path of the machine that generated it.
  root: path.relative(process.cwd(), root).split(path.sep).join("/"),
  extension,
  corpusFiles: train.length,
  heldOutFiles: heldOut.length,
  linesPerFile,
  corpusMixtureLimit: CORPUS_MIXTURE_LIMIT,
  contextSymbols: CONTEXT_SYMBOLS,
  rows,
  best,
  bestByOrder
}, null, 1)}\n`, "utf8");
process.stdout.write(`\nwrote ${outPath}\n`);

/**
 * Mean negative log probability of held-out lines the models were not shown.
 *
 * The local model is trained on the held-out file with the measured line removed, which is what the repair lane
 * has: the whole file except the thing it has to write. Coverage records how often the true symbol was in the
 * support at all, because a distribution that never assigns the right token any mass is failing differently from
 * one that assigns it too little.
 */
function measure({ corpusModels, order, weight }) {
  // The local model depends on the order and the line, never on the weight, so it is trained once per pair and
  // reused across the weight sweep. Without this the sweep spends nine tenths of its time retraining identically.
  const localCache = localModelCache(order);
  let total = 0;
  let symbols = 0;
  let covered = 0;
  for (const file of heldOut) {
    const lines = file.text.split(/\r?\n/u);
    const candidateIndexes = lines
      .map((line, index) => ({ line, index }))
      .filter(row => codeSurfaceTokens(row.line).length >= 4)
      .map(row => row.index);
    const step = Math.max(1, Math.floor(candidateIndexes.length / linesPerFile));
    for (const index of candidateIndexes.filter((_, position) => position % step === 0).slice(0, linesPerFile)) {
      const target = codeSurfaceTokens(lines[index]);
      if (!target.length) continue;
      const localModel = localCache(file.path, index, () => {
        const withoutLine = [...lines.slice(0, index), ...lines.slice(index + 1)].join("\n");
        return trainKneserNey(codeSurfaceTokens(withoutLine), { order, discount: 0.75, vocabularyLimit: 8192 });
      });
      const context = [
        ...codeSurfaceTokens(lines.slice(Math.max(0, index - 5), index).join("\n")),
        CODE_LINE_SYMBOL
      ].slice(-CONTEXT_SYMBOLS);
      const history = [...context];
      for (const symbol of target) {
        const corpus = corpusModels.length
          ? corpusModels.reduce((sum, model) => sum + kneserNeyProbability(model, history.slice(-(model.order - 1)), symbol), 0) / corpusModels.length
          : 0;
        const local = kneserNeyProbability(localModel, history.slice(-(localModel.order - 1)), symbol);
        const probability = weight * corpus + (1 - weight) * local;
        total += -Math.log(Math.max(1e-12, probability));
        symbols += 1;
        if (probability > 1e-12) covered += 1;
        history.push(symbol);
      }
    }
  }
  return { logPerplexity: symbols ? total / symbols : Infinity, symbols, coverage: symbols ? covered / symbols : 0 };
}

async function collectFiles(directory, ext, depth = 0) {
  if (depth > 6) return [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__" || entry.name.startsWith(".")) continue;
      out.push(...await collectFiles(full, ext, depth + 1));
      continue;
    }
    if (!entry.name.endsWith(ext)) continue;
    const text = await readFile(full, "utf8").catch(() => "");
    if (text.length > 400 && text.length < 200_000) out.push({ path: full, text });
  }
  return out;
}
