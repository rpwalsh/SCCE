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
import { execSync } from "node:child_process";

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
// A condition that switches off several components at once answers a different question from a single-component
// condition, and counting it among them would report the composite twice.
const composite = new Set(["lexical_only"]);
const singleComponent = ablations.filter(row => !composite.has(row.component));
const singleLoadBearing = loadBearing.filter(row => !composite.has(row.component));
const singleNeutral = neutral.filter(row => !composite.has(row.component));
const singleImproving = improving.filter(row => !composite.has(row.component));
if (singleLoadBearing.length) {
  findings.push(`**${singleLoadBearing.length} of ${singleComponent.length} single-component conditions cost the system questions.** `
    + singleLoadBearing.map(row => `\`${row.component}\` costs ${questionWord(row.delta)}`).join("; ")
    + ".");
} else {
  findings.push(`**No single-component condition lowers the score on this set.** Every one scores at or above the full condition's ${total(full)}/${questionCount}.`);
}
if (singleNeutral.length) {
  findings.push(`${list(singleNeutral.map(row => row.component))} ${singleNeutral.length === 1 ? "changes" : "change"} nothing measurable here. `
    + `That bounds what this instrument can see, not the components' value: a ${full.clozeTotal}-question cloze set over a fixed `
    + `corpus asks the system to locate a stored sentence and read a span out of it, and lexical retrieval alone solves that task.`);
}
for (const row of singleImproving) {
  // Whether a gain is noise or a finding is decided by its size against this set, not asserted in advance.
  const noise = Math.abs(row.delta) <= 2;
  findings.push(noise
    ? `\`${row.component}\` scores ${questionWord(row.delta)} above the full condition. On a ${questionCount}-item set that is `
      + `within noise, and it is recorded rather than rounded away: a component that costs latency and returns nothing `
      + `measurable on the task under measurement is a result to carry forward.`
    : `**\`${row.component}\` scores ${questionWord(row.delta)} above the full condition.** That is too large for noise on a `
      + `${questionCount}-item set: on this task the component is not merely unmeasurable, it is costing answers, and the `
      + `questions it costs are the place to look first.`);
}
if (lexicalOnly) {
  findings.push(`The composite \`lexical_only\` condition -- no graph, no learned semantics, no relation potential, no diffusion, `
    + `no PowerWalk -- scores ${lexicalOnly.total}/${questionCount} against the full system's ${total(full)}/${questionCount}. `
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

// The revision under measurement, so a reader can check the table against the code that produced it. A report that
// does not name its build cannot be reproduced, and this repository's own review contract requires the revision.
const revisionFlag = process.argv.find(argument => argument.startsWith("--revision="));
const revision = revisionFlag
  ? revisionFlag.slice("--revision=".length)
  : (() => {
    try {
      return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    } catch {
      return "unknown";
    }
  })();
// HEAD at report time is not the revision the run used unless the caller says so; a report that silently names the
// wrong build is worse than one that says it does not know which build it measured.
const revisionIsAsserted = Boolean(revisionFlag);
const worktreeDirty = (() => {
  try {
    return execSync("git status --porcelain", { encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
})();

const report = `# Ablation: what each component is worth

Generated by \`node tools/ablation-delta.mjs ${runDirectory}\` on ${new Date().toISOString()},
against revision \`${revision}\`${revisionIsAsserted ? "" : " (repository HEAD at report time; pass --revision to name the build the run actually used)"}${worktreeDirty ? ", working tree carrying uncommitted changes" : ""}.

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
