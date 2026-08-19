// Turns a completed run's objective scores into a defensible comparison:
// per-category accuracy, a cluster-bootstrapped paired effect against a
// reference system with Holm-Bonferroni correction, and the release-gate
// verdict.
//
// evaluation-release-gate.ts states in its own header that it "does not
// itself compute the three named metrics from a live evaluation run
// (that requires actually running one, plan item 240)". This is that
// computation: the gate and the paired statistics are imported, never
// reimplemented, so the thresholds enforced here are the same ones the
// kernel enforces.
import { readFileSync } from "node:fs";
import { evaluateReleaseGate } from "../../../packages/kernel/dist/evaluation-release-gate.js";
import { estimateClassEffectLCB, holmBonferroniCorrection } from "../../../packages/kernel/dist/paired-evaluation-statistics.js";

const readJsonl = file => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));

export function pairedReleaseReport(input) {
  const scores = readJsonl(input.objectivePath);
  const questions = readJsonl(input.questionsPath);
  const questionById = new Map(questions.map(question => [question.questionId, question]));

  const bySystem = new Map();
  for (const row of scores) {
    if (!bySystem.has(row.systemId)) bySystem.set(row.systemId, new Map());
    bySystem.get(row.systemId).set(row.questionId, row);
  }
  const subject = bySystem.get(input.systemId);
  const reference = bySystem.get(input.referenceSystemId);
  if (!subject) throw new Error(`no scores for system ${input.systemId}`);

  // Per-category accuracy for both systems.
  const categories = {};
  for (const [questionId, row] of subject) {
    const category = questionById.get(questionId)?.category ?? "unknown";
    categories[category] ??= { n: 0, subjectCorrect: 0, referenceCorrect: 0, coherent: 0 };
    categories[category].n++;
    if (row.exactScore === 1) categories[category].subjectCorrect++;
    if (row.coherent) categories[category].coherent++;
    if (reference?.get(questionId)?.exactScore === 1) categories[category].referenceCorrect++;
  }

  // Paired results, clustered by category: the cluster is the unit of
  // resampling, so correlated items inside one family are not treated as
  // independent draws.
  const pairedResults = [];
  if (reference) {
    for (const [questionId, row] of subject) {
      const other = reference.get(questionId);
      if (!other) continue;
      const mine = row.exactScore === 1 ? 1 : 0;
      const theirs = other.exactScore === 1 ? 1 : 0;
      pairedResults.push({
        id: questionId,
        taskFamilyId: questionById.get(questionId)?.category ?? "unknown",
        value: mine === theirs ? 0 : (mine > theirs ? 1 : -1)
      });
    }
  }

  const alpha = input.alpha ?? 0.05;
  let classEffects;
  let corrected;
  if (pairedResults.length) {
    classEffects = estimateClassEffectLCB(pairedResults, {
      confidenceLevel: 1 - alpha,
      bootstrapSamples: input.bootstrapSamples ?? 10000
    });
    corrected = holmBonferroniCorrection(classEffects.map(effect => ({ id: effect.taskFamilyId, pValue: effect.pValue })), alpha);
  }

  // Release-gate metrics computed from the run itself. unsupportedRate is
  // the fraction of ASSERTED items that were wrong -- an answer the corpus
  // did not support. Abstentions are excluded from it deliberately:
  // declining is the correct behaviour this system is built for, and
  // counting it as unsupported would penalise exactly the property the
  // gate exists to protect.
  //
  // Enforcing that exclusion needs the per-question status, which the
  // objective scores do not carry -- they record exactScore, not whether
  // the system declined. Reading exactScore === 0 as "unsupported" silently
  // conflated the two: on the 2026-08-18 rerun it reported unsupportedRate
  // 100% for a system that asserted nothing at all, 159 of those 160 being
  // abstentions. Statuses come from the raw answers when supplied, and when
  // they are not, the metric is reported as unavailable rather than guessed.
  const statusByQuestion = new Map();
  if (input.answersPath) {
    for (const row of readJsonl(input.answersPath)) {
      if (row.systemId === input.systemId) statusByQuestion.set(row.questionId, row.status);
    }
  }
  const declined = questionId => statusByQuestion.get(questionId) === "abstained";
  const answered = [...subject.values()].filter(row => row.exactScore !== null && row.exactScore !== undefined);
  const abstentionRows = [...subject.entries()].filter(([questionId]) => questionById.get(questionId)?.gold?.unanswerable === true);
  const answerableRows = [...subject.entries()].filter(([questionId]) => questionById.get(questionId)?.gold?.unanswerable !== true);
  const assertedRows = statusByQuestion.size ? answerableRows.filter(([questionId]) => !declined(questionId)) : undefined;
  const abstainedOnAnswerable = statusByQuestion.size ? answerableRows.length - assertedRows.length : undefined;
  const metrics = {
    unsupportedRate: assertedRows
      ? (assertedRows.length ? assertedRows.filter(([, row]) => row.exactScore === 0).length / assertedRows.length : 0)
      : null,
    exactAnchorAccuracy: answerableRows.length ? answerableRows.filter(([, row]) => row.exactScore === 1).length / answerableRows.length : 0,
    cycleAccuracy: abstentionRows.length ? abstentionRows.filter(([, row]) => row.exactScore === 1).length / abstentionRows.length : 1
  };

  // A metric that could not be computed must never be scored as if it
  // passed. Without statuses the gate is not evaluated at all.
  const gate = metrics.unsupportedRate === null
    ? { passed: false, notEvaluated: true, failures: [{ id: "unsupported_rate", reason: "not evaluated: pass --answers=<raw-answers.jsonl> so abstentions can be separated from unsupported assertions" }] }
    : evaluateReleaseGate(metrics, {
      maxUnsupportedRate: input.maxUnsupportedRate ?? 0.2,
      minExactAnchorAccuracy: input.minExactAnchorAccuracy ?? 0.7,
      minCycleAccuracy: input.minCycleAccuracy ?? 0.9
    }, pairedResults.length ? pairedResults : undefined);

  return { categories, metrics, gate, classEffects, corrected, pairedCount: pairedResults.length, answeredCount: answered.length, assertedCount: assertedRows?.length, abstainedOnAnswerable };
}

const args = new Map(process.argv.slice(2).map(argument => {
  const [key, value] = argument.replace(/^--/, "").split("=");
  return [key, value ?? "true"];
}));
if (args.get("objective") && args.get("questions")) {
  const report = pairedReleaseReport({
    objectivePath: args.get("objective"),
    questionsPath: args.get("questions"),
    systemId: args.get("system") ?? "scce",
    referenceSystemId: args.get("reference") ?? "reference.bm25",
    answersPath: args.get("answers"),
    alpha: Number(args.get("alpha") ?? 0.05),
    bootstrapSamples: Number(args.get("bootstrap") ?? 10000)
  });
  const pct = value => (100 * value).toFixed(1) + "%";
  console.log("=== per-category accuracy ===");
  for (const [category, row] of Object.entries(report.categories)) {
    console.log(`  ${category.padEnd(14)} subject ${String(row.subjectCorrect).padStart(3)}/${row.n} (${pct(row.subjectCorrect / row.n)})   reference ${String(row.referenceCorrect).padStart(3)}/${row.n} (${pct(row.referenceCorrect / row.n)})   coherent ${row.coherent}/${row.n}`);
  }
  console.log("\n=== release-gate metrics (computed from this run) ===");
  console.log("  unsupportedRate     ", report.metrics.unsupportedRate === null
    ? "unavailable (pass --answers to separate abstentions from unsupported assertions)"
    : `${pct(report.metrics.unsupportedRate)} of ${report.assertedCount} asserted (${report.abstainedOnAnswerable} answerable items abstained)`);
  console.log("  exactAnchorAccuracy ", pct(report.metrics.exactAnchorAccuracy));
  console.log("  cycleAccuracy       ", pct(report.metrics.cycleAccuracy), "(abstention correctness)");
  console.log("  gate passed:", report.gate.passed);
  for (const failure of report.gate.failures) console.log("   FAIL:", failure.id, "-", failure.reason);
  if (report.classEffects) {
    console.log("\n=== paired effect vs reference (cluster bootstrap, Holm-Bonferroni) ===");
    const rejectById = new Map((report.corrected ?? []).map(row => [row.id, row]));
    for (const effect of report.classEffects) {
      const row = rejectById.get(effect.taskFamilyId);
      console.log(`  ${effect.taskFamilyId.padEnd(14)} n=${String(effect.sampleCount).padStart(3)} mean=${effect.meanEffect.toFixed(3)} LCB=${effect.lowerConfidenceBound.toFixed(3)} p=${effect.pValue.toFixed(4)} ${row?.reject ? "SIGNIFICANT" : "not significant"}`);
    }
  }
  console.log(`\npaired items: ${report.pairedCount}`);
}
