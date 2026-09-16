// Size-controlled held-out cross-population support. Read-only DB access.
import { readFileSync } from "node:fs";
import pg from "pg";
import { kneserNeyPerplexity, trainKneserNey } from "../packages/kernel/dist/kneser-ney.js";

const url = JSON.parse(readFileSync(new URL("../scce.config.local.json", import.meta.url), "utf8")).database.url;
const client = new pg.Client({ connectionString: url });
await client.connect();

// Document corpus: live wikipedia evidence spans.
const { rows } = await client.query(
  `SELECT text_content FROM scce3_runtime.evidence_spans
   WHERE text_content IS NOT NULL AND length(text_content) > 400
   ORDER BY id LIMIT 3000`
);
await client.end();
const documentText = rows.map(r => r.text_content).join("\n");

// Conversational corpus: the same public-domain dialogue files the dialogue population was trained from.
const dialogueFiles = ["pg844", "pg1656", "pg1929", "pg2542", "pg3328", "pg3825", "pg7700"];
const dialogueText = dialogueFiles
  .map(name => readFileSync(new URL(`../corpus/dialogue/${name}.txt`, import.meta.url), "utf8"))
  .join("\n");

// Equal train/held-out budgets on both sides. Cost bound, identical for the two populations.
const TRAIN_CHARS = 600_000;
const HELD_OUT_CHARS = 40_000;

function split(text, label) {
  const body = text.slice(Math.floor(text.length * 0.05));
  const train = body.slice(0, TRAIN_CHARS);
  const heldOut = body.slice(TRAIN_CHARS + 10_000, TRAIN_CHARS + 10_000 + HELD_OUT_CHARS);
  console.log(`${label}: corpus=${text.length} train=${train.length} heldOut=${heldOut.length}`);
  return { train, heldOut };
}

const conversational = split(dialogueText, "conversational");
const document = split(documentText, "document");

const options = { order: 4, vocabularyLimit: 8192 };
const dialogueModel = trainKneserNey(conversational.train, options);
const documentModel = trainKneserNey(document.train, options);
console.log(`\ndialogue  population: obs=${dialogueModel.observedSymbolCount} vocab=${dialogueModel.vocabularySize} order=${dialogueModel.order}`);
console.log(`document  population: obs=${documentModel.observedSymbolCount} vocab=${documentModel.vocabularySize} order=${documentModel.order}`);

for (const [label, heldOut] of [["CONVERSATIONAL held-out", conversational.heldOut], ["DOCUMENT held-out", document.heldOut]]) {
  const d = kneserNeyPerplexity(dialogueModel, heldOut);
  const w = kneserNeyPerplexity(documentModel, heldOut);
  console.log(`\n${label}`);
  console.log(`  dialogue population perplexity = ${d.toFixed(2)}`);
  console.log(`  document population perplexity = ${w.toFixed(2)}`);
  console.log(`  winner = ${d < w ? "DIALOGUE" : "DOCUMENT"}  ratio = ${(Math.max(d, w) / Math.min(d, w)).toFixed(3)}x`);
}
