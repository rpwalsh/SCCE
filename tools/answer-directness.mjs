#!/usr/bin/env node
// Does a correct answer ANSWER, or merely contain the fact?
//
// The head-to-head grader scores by substring containment, symmetrically for both systems, so "correct" says the
// expected fact is somewhere in the answer. An answer that opens with four sentences of biography and reaches the
// fact in sentence three is scored the same as one that states it. This reports the second number: of the answers
// the runner already judged correct, how many carry the expected fact in their opening characters.
//
// It NEVER re-judges. It reads the verdict the runner recorded and only measures where the fact sits, which is
// safe on results files written before the storage fix too: those clipped the stored answer at 300 characters,
// and clipping a tail cannot move a fact that is inside the first 60.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const HEAD = Number(flag("head", 60));
const suitePath = flag("suite", "artifacts/head-to-head/suite.json");
const files = args.filter((arg, index) => !arg.startsWith("--") && !(index > 0 && args[index - 1].startsWith("--")));

const gold = new Map();
for (const item of JSON.parse(readFileSync(suitePath, "utf8")).items) {
  gold.set(item.id, [...(item.gold?.requiredStrings ?? []), ...(item.gold?.acceptedAnswers ?? [])].filter(Boolean));
}

const fold = value => String(value ?? "").normalize("NFC").toLocaleLowerCase();

for (const file of files) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const rows = parsed.rows ?? parsed;
  const byWorkload = new Map();
  let correct = 0;
  let direct = 0;
  let lengthTotal = 0;
  for (const row of rows) {
    const side = row.scce ?? row;
    if (side?.verdict !== "correct") continue;
    const strings = gold.get(row.id) ?? [];
    if (!strings.length) continue;
    const answer = fold(side.answer);
    const head = answer.slice(0, HEAD);
    const isDirect = strings.some(value => head.includes(fold(value)));
    correct += 1;
    lengthTotal += String(side.answer ?? "").length;
    if (isDirect) direct += 1;
    const bucket = byWorkload.get(row.workload) ?? { correct: 0, direct: 0 };
    bucket.correct += 1;
    if (isDirect) bucket.direct += 1;
    byWorkload.set(row.workload, bucket);
  }
  const buried = correct - direct;
  console.log(`${file}`);
  console.log(`  correct ${correct} | fact within first ${HEAD} chars ${direct} | buried deeper ${buried}` +
    (correct ? ` (${(buried / correct * 100).toFixed(1)}%)` : "") +
    ` | mean length ${correct ? Math.round(lengthTotal / correct) : 0} ch`);
  for (const [workload, bucket] of [...byWorkload].sort()) {
    console.log(`    ${workload.padEnd(16)} correct ${String(bucket.correct).padStart(3)}  direct ${String(bucket.direct).padStart(3)}`);
  }
}
