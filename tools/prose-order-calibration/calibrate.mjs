#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// What order should a prose corpus be trained at?
//
// The code lane's order (5) was measured (tools/code-generation-calibration). The prose lane's order was not:
// it took DEFAULT_NGRAM_SETTINGS.maxOrder = 4, and a third site (language.ts) trains at 6, so the codebase held
// two different unjustified answers. This sweep measures the one condition that matters for writing fiction:
// given the words that precede it, how surprised is the model by the next word of a real novel it was not shown?
//
// Method mirrors the code sweep so the two are comparable. Books are split into corpus and held-out sets by a
// deterministic stride; for each held-out passage the model predicts each symbol from its preceding context.
// Reported as mean negative log probability per symbol (log perplexity, nats/token): lower is better, and a
// difference of 1.0 is a factor of e in how surprised the model is by real prose.
//
//   node --max-old-space-size=7168 tools/prose-order-calibration/calibrate.mjs [--root=corpus/gutenberg]
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const kernel = await import(pathToFileURL(path.resolve("packages/kernel/dist/index.js")).href);
const { symbolizeData, trainKneserNey, kneserNeyProbability } = kernel;
const adapters = await import(pathToFileURL(path.resolve("packages/adapters-node/dist/index.js")).href);
const { stripGutenbergBoilerplate } = adapters;

const args = new Map(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => {
  const at = a.indexOf("=");
  return at < 0 ? [a.slice(2), "true"] : [a.slice(2, at), a.slice(at + 1)];
}));
const root = path.resolve(args.get("root") ?? "corpus/gutenberg");
const heldOutBooks = Number(args.get("heldout") ?? 4);
const passagesPerBook = Number(args.get("passages") ?? 12);
const passageSymbols = Number(args.get("passageSymbols") ?? 60);
const corpusSymbolCap = Number(args.get("cap") ?? 400_000);
const outPath = args.get("out") ?? "tools/prose-order-calibration/report.json";

// Beyond 9 the count tables outgrow the budget long before the context helps; the sweep is there to show the turn.
const ORDERS = [2, 3, 4, 5, 6, 7, 8, 9];
const VOCABULARY_LIMIT = Number(args.get("vocab") ?? 8192);
const DISCOUNT = 0.75;

const names = (await readdir(root)).filter(name => name.endsWith(".txt")).sort();
if (names.length < heldOutBooks + 2) {
  process.stderr.write(`need at least ${heldOutBooks + 2} .txt files under ${root}; found ${names.length}\n`);
  process.exit(1);
}
const books = [];
for (const name of names) {
  const raw = await readFile(path.join(root, name), "utf8");
  books.push({ name, symbols: symbolizeData(stripGutenbergBoilerplate(raw)) });
}
// Deterministic split by position so a re-run measures the same thing.
const stride = Math.ceil(books.length / heldOutBooks);
const heldOut = books.filter((_, index) => index % stride === 0).slice(0, heldOutBooks);
const heldOutNames = new Set(heldOut.map(book => book.name));
const train = books.filter(book => !heldOutNames.has(book.name));

const corpusSymbols = [];
for (const book of train) {
  for (const symbol of book.symbols) {
    corpusSymbols.push(symbol);
    if (corpusSymbols.length >= corpusSymbolCap) break;
  }
  if (corpusSymbols.length >= corpusSymbolCap) break;
}
process.stdout.write(`corpus ${train.length} books (${corpusSymbols.length} symbols), held out ${heldOut.map(b => b.name).join(", ")}\n`);
process.stdout.write(`${passagesPerBook} passages per held-out book, ${passageSymbols} symbols each\n\n`);

/** Passages the model was never shown, sampled across each held-out book rather than from its opening. */
function heldOutPassages(book) {
  const out = [];
  const usable = book.symbols.length - passageSymbols - 1;
  if (usable <= 0) return out;
  const step = Math.floor(usable / (passagesPerBook + 1));
  for (let index = 1; index <= passagesPerBook; index++) {
    const start = step * index;
    out.push(book.symbols.slice(start, start + passageSymbols));
  }
  return out;
}
const passages = heldOut.flatMap(book => heldOutPassages(book));

const rows = [];
for (const order of ORDERS) {
  const started = Date.now();
  const model = trainKneserNey(corpusSymbols, { order, discount: DISCOUNT, vocabularyLimit: VOCABULARY_LIMIT });
  let total = 0;
  let symbols = 0;
  let covered = 0;
  for (const passage of passages) {
    for (let index = 1; index < passage.length; index++) {
      const history = passage.slice(Math.max(0, index - (order - 1)), index);
      const probability = kneserNeyProbability(model, history, passage[index]);
      if (probability > 0) covered += 1;
      // A zero-probability symbol is real evidence of failure, not a reason to skip: floor it rather than drop it.
      total += -Math.log(Math.max(probability, 1e-12));
      symbols += 1;
    }
  }
  const logPerplexity = total / Math.max(1, symbols);
  const row = {
    order,
    logPerplexity: Number(logPerplexity.toFixed(4)),
    coverage: Number((covered / Math.max(1, symbols)).toFixed(4)),
    symbols,
    vocabulary: model.vocabulary?.length ?? null,
    trainMs: Date.now() - started
  };
  rows.push(row);
  process.stdout.write(`order ${order}  log-perplexity ${row.logPerplexity.toFixed(4)}  covered ${(row.coverage * 100).toFixed(1)}%  vocab ${row.vocabulary}  (${(row.trainMs / 1000).toFixed(1)}s)\n`);
}

const best = [...rows].sort((a, b) => a.logPerplexity - b.logPerplexity)[0];
const shipped = rows.find(row => row.order === 4);
process.stdout.write(`\nminimum: order ${best.order}, log-perplexity ${best.logPerplexity}\n`);
if (shipped && shipped.order !== best.order) {
  const delta = shipped.logPerplexity - best.logPerplexity;
  process.stdout.write(`the shipped order 4 costs ${delta.toFixed(4)} nats/token against the minimum (${Math.exp(delta).toFixed(2)}x the perplexity)\n`);
} else if (shipped) {
  process.stdout.write("the shipped order 4 is the minimum of this sweep\n");
}

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify({
  schema: "scce.prose_order_calibration.v1",
  generatedAt: new Date().toISOString(),
  root: path.relative(process.cwd(), root).split(path.sep).join("/"),
  corpusBooks: train.length,
  corpusSymbols: corpusSymbols.length,
  heldOutBooks: heldOut.map(book => book.name),
  passagesPerBook,
  passageSymbols,
  vocabularyLimit: VOCABULARY_LIMIT,
  discount: DISCOUNT,
  rows,
  best
}, null, 1)}\n`, "utf8");
process.stdout.write(`\nwrote ${outPath}\n`);
