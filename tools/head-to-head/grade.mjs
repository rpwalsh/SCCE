// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// One grader for every head-to-head runner (live server, ablated in-process runtimes): the verdict of an item must not
// depend on which harness asked the question.
// ---- scoring ------------------------------------------------------------------------------------------------
export const normalize = value => String(value).replace(/\s+/gu, " ").trim().toLowerCase();
export const declines = answer => {
  const spoken = normalize(answer);
  if (!spoken) return true;
  return /(do not|does not|doesn't|don't|no (information|mention|reference|record|grounded source)|not (mentioned|found|provided|present|specified|available|contain|include)|cannot|can't|unable|unknown|not enough|isn't (mentioned|specified)|no specific)/u.test(spoken);
};
export function score(item, answer) {
  const spoken = normalize(answer);
  const declined = declines(answer);
  if (item.gold.ungraded) return { verdict: "ungraded", declined };
  if (item.gold.unanswerable) return { verdict: declined ? "declined" : "fabricated", declined };
  const forbidden = (item.gold.forbiddenStrings ?? []).some(s => spoken.includes(normalize(s)));
  const required = (item.gold.requiredStrings ?? []);
  const accepted = (item.gold.acceptedAnswers ?? []);
  const hasRequired = required.length
    ? required.every(s => normalize(s).split(/[\s,]+/u).filter(Boolean).every(part => spoken.includes(part)))
    : accepted.some(s => spoken.includes(normalize(s)));
  if (forbidden) return { verdict: "wrong", declined };
  if (hasRequired) return { verdict: "correct", declined };
  return { verdict: declined ? "declined_when_answerable" : "wrong", declined };
}

// ---- reporting ----------------------------------------------------------------------------------------------
const VERDICTS = ["correct", "wrong", "declined_when_answerable", "declined", "fabricated"];

/** Graded rows grouped by one field, so a corpus that scores zero cannot hide inside a healthy total. */
export function groupVerdicts(rows, side, field) {
  const groups = {};
  for (const row of rows) {
    const cell = row[side];
    if (!cell || cell.verdict === "ungraded") continue;
    const bucket = (groups[row[field] ?? "unlabelled"] ??= { items: 0, correct: 0, wrong: 0, declinedWhenAnswerable: 0, declined: 0, fabricated: 0, accuracy: 0 });
    bucket.items += 1;
    if (cell.verdict === "correct") bucket.correct += 1;
    else if (cell.verdict === "wrong") bucket.wrong += 1;
    else if (cell.verdict === "declined_when_answerable") bucket.declinedWhenAnswerable += 1;
    else if (cell.verdict === "declined") bucket.declined += 1;
    else if (cell.verdict === "fabricated") bucket.fabricated += 1;
  }
  for (const bucket of Object.values(groups)) bucket.accuracy = Number((bucket.correct / bucket.items).toFixed(4));
  return groups;
}

/** The per-corpus block as printed, so the offline check reads exactly what a live run prints. */
export function formatPerCorpus(byCorpus) {
  return Object.entries(byCorpus)
    .sort((a, b) => b[1].items - a[1].items)
    .map(([corpus, b]) =>
      `    ${corpus.padEnd(12)} ${String(b.correct).padStart(4)}/${String(b.items).padEnd(4)} ${(b.accuracy * 100).toFixed(1).padStart(5)}%  wrong ${b.wrong}, declined-when-answerable ${b.declinedWhenAnswerable}, fabricated ${b.fabricated}`);
}

/** Whole-run tallies plus the per-corpus and per-workload breakdowns. Pure: no server, no clock, no process state. */
export function summarizeVerdicts(rows, side) {
  const scored = rows.filter(row => row[side] && row[side].verdict !== "ungraded");
  const tally = Object.fromEntries(VERDICTS.map(v => [v, scored.filter(r => r[side].verdict === v).length]));
  return {
    items: scored.length,
    byCorpus: groupVerdicts(rows, side, "corpus"),
    byWorkload: groupVerdicts(rows, side, "workload"),
    correct: tally.correct,
    wrong: tally.wrong,
    declinedWhenAnswerable: tally.declined_when_answerable,
    declined: tally.declined,
    fabricated: tally.fabricated
  };
}

