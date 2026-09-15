import { objectiveScores } from "./objective.mjs";

const key = row => JSON.stringify([row.runId, row.systemId, row.conditionId]);
const quantile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
};

export function efficiencyReport({ answers, questions, measurements, questionsSha256 }) {
  const ids = new Set(questions.map(question => question.questionId));
  if (ids.size !== questions.length) throw new Error("duplicate question IDs in evaluation input");
  const measurementKeys = new Set();
  const systems = measurements.map(measurement => {
    const identity = key(measurement);
    if (measurementKeys.has(identity)) throw new Error("duplicate condition measurement");
    measurementKeys.add(identity);
    if (questionsSha256 && measurement.inputHashes?.questions !== questionsSha256)
      throw new Error("scoring questions do not match the measured input hash");
    const rows = answers.filter(answer => key(answer) === identity);
    const seen = new Set();
    const integrityFailures = [];
    for (const row of rows) {
      if (!ids.has(row.questionId)) integrityFailures.push(`unexpected-question:${row.questionId}`);
      if (seen.has(row.questionId)) integrityFailures.push(`duplicate-answer:${row.questionId}`);
      if (row.attempt !== 1) integrityFailures.push(`unexpected-attempt:${row.questionId}`);
      seen.add(row.questionId);
    }
    for (const id of ids) if (!seen.has(id)) integrityFailures.push(`missing-answer:${id}`);
    if (measurement.expectedQuestionCount !== questions.length) integrityFailures.push("question-count-mismatch");
    if (!(measurement.wallElapsedMs > 0)) integrityFailures.push("invalid-measured-duration");
    const scores = objectiveScores(rows, questions);
    const scoredTaskCount = scores.filter(score => score.objectiveAvailable).length;
    const correctTaskCount = scores.filter(score => score.exactScore === 1).length;
    const completedTaskCount = rows.filter(row => row.status === "ok" || row.status === "abstained").length;
    const durationSeconds = measurement.wallElapsedMs / 1000;
    const usable = integrityFailures.length === 0;
    const energyAvailable = usable && measurement.energy?.status === "measured" && measurement.energy.joules > 0;
    const joules = energyAvailable ? measurement.energy.joules : null;
    const observed = rows.map(row => row.observedElapsedMs).filter(value => Number.isFinite(value) && value >= 0);
    const subsequent = rows.slice(1).map(row => row.observedElapsedMs).filter(value => Number.isFinite(value) && value >= 0);
    const categories = {};
    const categoryByQuestion = new Map(questions.map(question => [question.questionId, question.category ?? "unknown"]));
    for (const score of scores) {
      const category = categoryByQuestion.get(score.questionId) ?? "unknown";
      const total = categories[category] ??= { scored: 0, correct: 0 };
      if (score.objectiveAvailable) total.scored++;
      if (score.exactScore === 1) total.correct++;
    }
    return {
      runId: measurement.runId, systemId: measurement.systemId, conditionId: measurement.conditionId,
      status: usable ? "measured" : "invalid", integrityFailures,
      inputHashes: measurement.inputHashes, taskCount: questions.length, completedTaskCount,
      failedTaskCount: rows.length - completedTaskCount, scoredTaskCount, correctTaskCount,
      accuracy: usable && scoredTaskCount ? correctTaskCount / scoredTaskCount : null,
      categories, wallElapsedMs: measurement.wallElapsedMs,
      completedTasksPerSecond: usable ? completedTaskCount / durationSeconds : null,
      correctTasksPerSecond: usable ? correctTaskCount / durationSeconds : null,
      latencyMs: {
        source: "harness-observed; first answer includes adapter initialization",
        first: Number.isFinite(rows[0]?.observedElapsedMs) ? rows[0].observedElapsedMs : null,
        median: quantile(observed, 0.5), p95: quantile(observed, 0.95),
        subsequentMedian: quantile(subsequent, 0.5), subsequentP95: quantile(subsequent, 0.95)
      },
      energy: measurement.energy,
      joules,
      // One binary objective point per correct task. Errors consume energy and
      // elapsed time but produce zero useful work. Missing energy stays null.
      objectiveScorePoints: usable ? correctTaskCount : null,
      scorePointsPerKilojoule: joules ? 1000 * correctTaskCount / joules : null,
      correctTasksPerKilojoule: joules ? 1000 * correctTaskCount / joules : null,
      joulesPerCorrectTask: joules && correctTaskCount ? joules / correctTaskCount : null,
      correctTasksPerSecondPerWatt: joules ? correctTaskCount / joules : null
    };
  });
  return {
    schemaVersion: "1.0", kind: "local-workload-efficiency",
    usefulWorkDefinition: "One point per objective-correct task, including correct abstentions. The declared string rubric is not a general reasoning or citation-quality score.",
    powerDefinition: "correct tasks/second/watt = correct tasks/joule; gross measured energy includes idle and background work in the declared sensor scope",
    limits: [
      "Per-condition session measurements; preprocessing/ingestion before adapter startup is excluded and must be reported separately.",
      "First-answer latency includes adapter initialization; subsequent requests may benefit from cache state. This is not a separately controlled cold/warm experiment.",
      "These local measurements do not establish fresh held-out integrity or a public-review result. Repeated, order-balanced runs and quality review are required for comparative claims."
    ], systems
  };
}
