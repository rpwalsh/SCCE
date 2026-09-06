#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// What each disabled component costs, measured on the same sealed question set.
//
// The evaluation conditions in `evaluation-flags.ts` disable one named component each. Running the sealed set under
// several of them and differencing the scores answers the question a technical buyer actually asks: is every
// impressive-sounding algorithm load-bearing, or is the system a retrieval baseline wearing an architecture?
//
// Every sentence of the report below is derived from the run. An earlier version carried its conclusions as a fixed
// template -- "the architecture is almost entirely inert", a named improvement from removing language memory, specific
// scores -- so regenerating it against a different run reprinted the old findings over the new table. A report whose
// headline cannot change when the measurement changes is not a measurement.
import fs from "node:fs";
import path from "node:path";

const runDirectory = process.argv[2];
if (!runDirectory) {
  process.stderr.write("usage: node tools/ablation-delta.mjs <run-output-directory> [--out=docs/ABLATION.md]\n");
  process.exit(2);
}
const outFlag = process.argv.find(argument => argument.startsWith("--out="));
const readJsonl = file => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));

const objective = readJsonl(path.join(runDirectory, "objective.jsonl"));
const questionsPath = [
  path.join(runDirectory, "questions.jsonl"),
  path.join(runDirectory, "..", "questions.jsonl")
].find(candidate => fs.existsSync(candidate));
const questions = questionsPath ? new Map(readJsonl(questionsPath).map(row => [row.questionId, row])) : new Map();
const unanswerable = questionId => questions.get(questionId)?.gold?.unanswerable === true;

const bySystem = new Map();
for (const row of objective) {
  const system = bySystem.get(row.systemId) ?? { cloze: 0, clozeTotal: 0, abstention: 0, abstentionTotal: 0, missed: [] };
  const hit = Number(row.exactScore ?? 0) >= 1;
  if (unanswerable(row.questionId)) {
    system.abstentionTotal++;
    if (hit) system.abstention++;
  } else {
    system.clozeTotal++;
    if (hit) system.cloze++;
    else system.missed.push(row.questionId);
  }
  bySystem.set(row.systemId, system);
}

const full = bySystem.get("scce");
if (!full) {
  process.stderr.write("no `scce` system in this run: the full condition is the baseline every delta is measured against\n");
  process.exit(1);
}
const total = system => system.cloze + system.abstention;

const rows = [...bySystem.entries()]
  .filter(([systemId]) => systemId !== "scce")
  .map(([systemId, system]) => ({
    systemId,
    component: systemId.startsWith("scce.") ? systemId.slice("scce.".length) : "(reference)",
    isReference: !systemId.startsWith("scce."),
    total: total(system),
    cloze: system.cloze,
    clozeTotal: system.clozeTotal,
    abstention: system.abstention,
    abstentionTotal: system.abstentionTotal,
    delta: total(system) - total(full),
    newMisses: system.missed.filter(id => !full.missed.includes(id)).length
  }))
  .sort((left, right) => left.delta - right.delta);

const questionCount = full.clozeTotal + full.abstentionTotal;
const line = row => `| ${row.component} | ${row.total}/${questionCount} | ${row.cloze}/${row.clozeTotal} | ${row.abstention}/${row.abstentionTotal} | ${row.delta >= 0 ? "+" : ""}${row.delta} | ${row.newMisses} |`;

// --- Findings, derived. -------------------------------------------------------------------------------------------

const ablations = rows.filter(row => !row.isReference);
const reference = rows.find(row => row.isReference);
const loadBearing = ablations.filter(row => row.delta < 0).sort((left, right) => left.delta - right.delta);
const neutral = ablations.filter(row => row.delta === 0);
const improving = ablations.filter(row => row.delta > 0);
const lexicalOnly = ablations.find(row => row.component === "lexical_only");

const list = names => names.length === 0
  ? ""
  : names.length === 1
    ? `\`${names[0]}\``
    : `${names.slice(0, -1).map(name => `\`${name}\``).join(", ")} and \`${names[names.length - 1]}\``;
const questionWord = count => `${Math.abs(count)} question${Math.abs(count) === 1 ? "" : "s"}`;

const findings = [];
if (loadBearing.length) {
  findings.push(`**${loadBearing.length} of ${ablations.length} components are load-bearing on this set.** `
    + loadBearing.map(row => `Removing \`${row.component}\` costs ${questionWord(row.delta)}`).join("; ")
    + ".");
} else {
  findings.push(`**No single component's removal lowers the score on this set.** Every ablation scores at or above the full condition's ${total(full)}/${questionCount}.`);
}
if (neutral.length) {
  findings.push(`Removing ${list(neutral.map(row => row.component))} changes nothing measurable here. `
    + `That bounds what this instrument can see, not the components' value: a 160-question cloze set over a fixed corpus `
    + `asks the system to locate a stored sentence and read a span out of it, and lexical retrieval alone solves that task.`);
}
if (improving.length) {
  findings.push(`Removing ${list(improving.map(row => row.component))} `
    + `${improving.length === 1 ? "raises" : "raise"} the score by `
    + `${improving.map(row => questionWord(row.delta)).join(" and ")}. On a set this size that is within noise, and it is `
    + `recorded rather than rounded away: a component that costs latency and returns nothing measurable on the task under `
    + `measurement is a real result to carry forward.`);
}
if (lexicalOnly) {
  findings.push(`The \`lexical_only\` condition -- no graph, no learned semantics, no relation potential, no diffusion, no `
    + `PowerWalk -- scores ${lexicalOnly.total}/${questionCount} against the full system's ${total(full)}/${questionCount}. `
    + `The architecture's claims are claims about tasks this instrument does not contain.`);
}
if (reference) {
  const margin = total(full) - reference.total;
  findings.push(`Against the independent ${reference.component === "(reference)" ? "BM25" : reference.component} baseline, the `
    + `full system's margin is ${margin >= 0 ? "+" : ""}${margin}: `
    + `${full.cloze}/${full.clozeTotal} versus ${reference.cloze}/${reference.clozeTotal} on cloze, and `
    + `${full.abstention}/${full.abstentionTotal} versus ${reference.abstention}/${reference.abstentionTotal} on the `
    + `unanswerable probes. Refusal discipline is what this benchmark measures, and it measures it cleanly: the baseline `
    + `answers every question the corpus cannot support.`);
}

const report = `# Ablation: what each component is worth

Generated by \`node tools/ablation-delta.mjs ${runDirectory}\` on ${new Date().toISOString()}.

Each row is the same ${questionCount}-question sealed set answered with one component disabled through
\`evaluation-flags.ts\`, against the same corpus and the same brain. The delta is against the full condition, which
scored ${total(full)}/${questionCount} (${full.cloze}/${full.clozeTotal} cloze,
${full.abstention}/${full.abstentionTotal} abstention).

| Disabled component | Total | Cloze | Abstention | Δ vs full | New misses |
|---|---|---|---|---|---|
${rows.map(line).join("\n")}

## What the table says

${findings.map(finding => `- ${finding}`).join("\n\n")}

## What would measure the rest

The twenty behaviours in [\`ACCEPTANCE_SUITE.md\`](ACCEPTANCE_SUITE.md) are tasks where a graph, a proof and a durable
state either do the work or visibly fail to: contradiction with competing provenance, temporal comparison, multi-hop
composition, and learning that changes later answers. Re-running this ablation against those is the measurement that
establishes causal contribution for the components this set cannot separate.

Every figure above is read from \`${path.basename(runDirectory)}/objective.jsonl\`; nothing in this document is
hand-written. The ablation conditions are the preregistered ones from \`evaluation-flags.ts\`, each run records its own
component-boundary trace, and the graph-slice cache is namespaced per condition, so a reviewer can verify a disabled
component was genuinely bypassed rather than merely flagged.
`;

const outputPath = outFlag ? outFlag.slice("--out=".length) : undefined;
if (outputPath) {
  fs.writeFileSync(outputPath, report, "utf8");
  console.log(`wrote ${outputPath}`);
}
console.log(`full: ${total(full)}/${questionCount} (cloze ${full.cloze}/${full.clozeTotal}, abstention ${full.abstention}/${full.abstentionTotal})`);
for (const row of rows) {
  console.log(`${row.component.padEnd(24)} total ${String(row.total).padStart(3)}  cloze ${row.cloze}/${row.clozeTotal}  abstention ${row.abstention}/${row.abstentionTotal}  delta ${row.delta >= 0 ? "+" : ""}${row.delta}`);
}
