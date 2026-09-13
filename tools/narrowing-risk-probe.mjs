#!/usr/bin/env node
// Would narrowing an answer to its leading sentence ever drop the fact that made it correct?
//
// Offline, and it says so: it reads the STORED answer of each correct row rather than re-running the plan, so it
// approximates the plan's sentence list with the sentences actually spoken. That is the right population for the
// question being asked -- every one of these is an answer the grader already scored correct -- but it is not the
// live path, and .agent/context records three occasions where an offline harness disagreed with the server. Treat
// a loss here as a reason to look, not as a verdict.
import { readFileSync } from "node:fs";
import { requestRelationBeyondSourceIdentity } from "../packages/kernel/dist/local-evidence-runtime.js";
import { splitSurfaceSentences } from "../packages/kernel/dist/surface-linguistics.js";

const results = process.argv[2] ?? "artifacts/head-to-head/results-baseline-20260913.json";
const suite = JSON.parse(readFileSync("artifacts/head-to-head/suite.json", "utf8"));
const gold = new Map(suite.items.map(i => [i.id, [...(i.gold?.requiredStrings ?? []), ...(i.gold?.acceptedAnswers ?? [])].filter(Boolean)]));
const rows = JSON.parse(readFileSync(results, "utf8")).rows;
const fold = v => String(v ?? "").normalize("NFC").toLocaleLowerCase();

// The runner appends "Source: <title> (<url>)"; the title is what the span's identity would supply.
const sourceTitle = answer => (/\n?Source:\s*([^(\n]+?)\s*\(/u.exec(String(answer ?? "")) ?? [])[1]?.trim() ?? "";
const stripCitation = answer => String(answer ?? "").replace(/\n*Source:[\s\S]*$/u, "").trim();
const spanFor = title => ({
  id: "probe", sourceVersionId: "probe:v1", text: "", textPreview: "", status: "promoted", alpha: 0.9, charStart: 0,
  provenance: { uri: "fixture://probe", title, sourceVersionId: "probe:v1", metadata: { title } }
});

const overlap = (sentence, units) => {
  const surface = new Set(fold(sentence).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  let n = 0;
  for (const unit of units) if ([...surface].some(w => w === unit || (w.length > 3 && unit.length > 3 && (w.startsWith(unit) || unit.startsWith(w))))) n += 1;
  return n;
};

let considered = 0, narrowed = 0, keptGold = 0, lostGold = 0, becameDirect = 0, alreadyDirect = 0;
const losses = [];
for (const row of rows) {
  if (row.scce?.verdict !== "correct") continue;
  if (row.workload === "cloze") continue; // near-duplicate turns are excluded from narrowing by construction
  const g = gold.get(row.id) ?? [];
  if (!g.length) continue;
  const body = stripCitation(row.scce.answer);
  const sentences = splitSurfaceSentences(body).map(s => s.trim()).filter(Boolean);
  if (sentences.length < 2) continue;
  const units = requestRelationBeyondSourceIdentity(row.prompt, spanFor(sourceTitle(row.scce.answer)), new Set());
  if (!units.length) continue;
  considered += 1;
  const carriage = sentences.map(s => overlap(s, units));
  const lead = Math.max(...carriage);
  if (lead <= Math.min(...carriage)) continue;
  narrowed += 1;
  const kept = sentences.filter((_, i) => carriage[i] === lead).join(" ");
  const hadGold = g.some(v => fold(body).includes(fold(v)));
  const hasGold = g.some(v => fold(kept).includes(fold(v)));
  if (!hadGold) continue; // gold past the runner's 300-char store; nothing to conclude
  if (hasGold) keptGold += 1; else { lostGold += 1; losses.push({ id: row.id, gold: g[0], kept: kept.slice(0, 110) }); }
  const wasDirect = g.some(v => fold(body).slice(0, 60).includes(fold(v)));
  const isDirect = g.some(v => fold(kept).slice(0, 60).includes(fold(v)));
  if (wasDirect) alreadyDirect += 1; else if (isDirect) becameDirect += 1;
}
console.log(`${results}`);
console.log(`  multi-sentence correct non-cloze answers with a non-empty asked relation : ${considered}`);
console.log(`  of those, one sentence strictly leads                                    : ${narrowed}`);
console.log(`  narrowed answers that KEEP the gold                                      : ${keptGold}`);
console.log(`  narrowed answers that LOSE the gold  (would regress correct -> wrong)    : ${lostGold}`);
console.log(`  buried -> direct                                                         : ${becameDirect}`);
console.log(`  already direct                                                           : ${alreadyDirect}`);
for (const loss of losses) console.log(`    LOSS ${loss.id} gold="${loss.gold}" kept="${loss.kept}"`);
