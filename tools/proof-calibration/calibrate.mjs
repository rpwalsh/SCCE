#!/usr/bin/env node
// Calibrates the proof calculus's decision thresholds against a labelled set instead of asserting them.
//
// Every threshold in semantic-proof-system.ts predates measurement: 0.42 for admitting a counterexample, 0.12 for
// admitting a support step, 0.55 for the CONTRADICTED verdict. They were hand-chosen and carried forward. This
// harness produces the evidence a threshold needs: the distribution of the underlying quantity over pairs whose
// label is known, the separation between those distributions, and the operating point that separation implies.
//
// Labels come from construction and from the corpus, never from a model:
//   POSITIVE  a minimal pair -- two sentences identical except for one asserted value (a date, a measurement, a
//             count). Changing exactly one asserted value is what "these disagree" means, so the label is carried by
//             the construction rather than by anyone's judgement.
//   NEGATIVE  (a) restatements of one fact, (b) same predicate applied to DIFFERENT subjects, (c) different
//             predicates about the SAME subject, and (d) real sentence pairs drawn from inside a single corpus
//             document. (b) and (c) are the adversarial negatives: they hold correspondence high while disagreement
//             must stay low, which is exactly where a badly placed threshold suppresses correct answers. (d) is the
//             natural-distribution control -- one document is presumed internally consistent.
//
// Deterministic: the corpus sample is drawn by a seeded shuffle over an ordered query, so a rerun reproduces the run.
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createHasher, createSemanticProofSystem, hasPredicateSubstance, PROOF_CONTRADICTION_THRESHOLD } from "../../packages/kernel/dist/index.js";

const require_ = createRequire(pathToFileURL(path.resolve("packages/adapters-node/package.json")));

const SUBJECTS = [
  ["the Drennish reactor", "was commissioned on"],
  ["the Ostry tunnel", "was opened on"],
  ["the Marlin bridge", "was completed on"],
  ["the Calder observatory", "was dedicated on"]
];
const DATES = [["11 April 1988", "3 September 1991"], ["14 June 1972", "27 January 1980"]];
const MEASURED = [
  ["Xylor-7", "decomposes at", "degrees Celsius", 417, 431],
  ["the summit of Mount Verrick", "is", "metres above sea level", 3412, 3388],
  ["the Halvern furnace", "operates at", "kilopascals", 220, 260],
  ["the Renner aquifer", "yields", "litres per second", 58, 74]
];
const COUNTED = [
  ["Factory A", "had", "machines", 12, 30],
  ["the Ostry depot", "stored", "railcars", 9, 21]
];

function minimalPairs() {
  const positives = [];
  const negatives = [];
  for (const [subject, predicate] of SUBJECTS) {
    for (const [left, right] of DATES) {
      positives.push({ kind: "date", a: `${cap(subject)} ${predicate} ${left}.`, b: `${cap(subject)} ${predicate} ${right}.` });
      negatives.push({ kind: "restatement", a: `${cap(subject)} ${predicate} ${left}.`, b: `${cap(subject)} ${predicate} ${left}.` });
    }
  }
  for (const [subject, predicate, unit, low, high] of MEASURED) {
    positives.push({ kind: "measurement", a: `${cap(subject)} ${predicate} ${low} ${unit}.`, b: `${cap(subject)} ${predicate} ${high} ${unit}.` });
  }
  for (const [subject, predicate, unit, low, high] of COUNTED) {
    positives.push({ kind: "count", a: `${cap(subject)} ${predicate} ${low} ${unit}.`, b: `${cap(subject)} ${predicate} ${high} ${unit}.` });
  }
  // Same predicate, different subject: high correspondence, no disagreement. A threshold placed below this band
  // reports a conflict between two facts that are both true, which is what suppressed the Babbage answer.
  for (let i = 0; i < SUBJECTS.length; i++) {
    for (let j = i + 1; j < SUBJECTS.length; j++) {
      const [subjectA, predicateA] = SUBJECTS[i];
      const [subjectB] = SUBJECTS[j];
      negatives.push({
        kind: "different-subject",
        a: `${cap(subjectA)} ${predicateA} ${DATES[0][0]}.`,
        b: `${cap(subjectB)} ${predicateA} ${DATES[0][1]}.`
      });
    }
  }
  for (let i = 0; i < MEASURED.length; i++) {
    for (let j = i + 1; j < MEASURED.length; j++) {
      const [subjectA, predicateA, unitA, lowA] = MEASURED[i];
      const [subjectB, predicateB, unitB, lowB] = MEASURED[j];
      negatives.push({
        kind: "different-subject",
        a: `${cap(subjectA)} ${predicateA} ${lowA} ${unitA}.`,
        b: `${cap(subjectB)} ${predicateB} ${lowB} ${unitB}.`
      });
    }
  }
  // Different predicate, same subject: both true of one entity, and nothing about them is in conflict.
  for (const [subject] of SUBJECTS) {
    negatives.push({
      kind: "different-predicate",
      a: `${cap(subject)} was commissioned on ${DATES[0][0]}.`,
      b: `${cap(subject)} was surveyed by the Halvern institute.`
    });
  }
  return { positives, negatives };
}

const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// Deterministic PRNG so a rerun draws the same corpus sample.
function seededRandom(seed) {
  let state = [...seed].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7);
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+/u)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 40 && sentence.length <= 240 && /[\p{Letter}]/u.test(sentence));
}

async function corpusNegatives(limitDocuments, pairsPerDocument, seed) {
  const cfg = JSON.parse(fs.readFileSync("scce.config.json", "utf8"));
  let local = {};
  try { local = JSON.parse(fs.readFileSync("scce.config.local.json", "utf8")); } catch { /* optional overlay */ }
  const url = local?.database?.url ?? cfg.database?.url;
  const schema = local?.database?.schema ?? cfg.database?.schema;
  if (!url || limitDocuments <= 0) return [];
  const pg = require_("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(`SET search_path TO "${schema}"`);
  const { rows } = await client.query(
    `SELECT source_version_id, string_agg(text_content, ' ' ORDER BY char_start) AS body
     FROM evidence_spans
     GROUP BY source_version_id
     HAVING SUM(LENGTH(text_content)) BETWEEN 2000 AND 60000
     ORDER BY source_version_id ASC
     LIMIT $1`,
    [limitDocuments]
  );
  await client.end();
  const random = seededRandom(seed);
  const negatives = [];
  for (const row of rows) {
    const sentences = splitSentences(row.body);
    if (sentences.length < 4) continue;
    for (let n = 0; n < pairsPerDocument; n++) {
      const i = Math.floor(random() * sentences.length);
      let j = Math.floor(random() * sentences.length);
      if (i === j) j = (j + 1) % sentences.length;
      negatives.push({ kind: "same-document", a: sentences[i], b: sentences[j] });
    }
  }
  return negatives;
}

function scorePairs(proof, pairs) {
  const scored = [];
  for (const pair of pairs) {
    const [left] = proof.atomizeClaim(pair.a);
    const [right] = proof.atomizeClaim(pair.b);
    if (!left || !right) continue;
    const unified = proof.unify(left, right);
    // searchProof admits a counterexample only between atoms that state a relation, so the harness scores the pair
    // the same way: a pair the proof would never compare must not be counted for or against a threshold.
    const admitted = hasPredicateSubstance(left.predicate) && hasPredicateSubstance(right.predicate);
    scored.push({ ...pair, admitted, contradiction: unified.contradiction, correspondence: unified.correspondence, support: unified.support });
  }
  return scored;
}

// Sweep every value that could change a decision -- the midpoints between adjacent observed scores -- rather than a
// fixed grid, so the reported optimum is an actual decision boundary and not an artefact of grid spacing.
function sweep(positives, negatives, field) {
  const values = [...new Set([...positives, ...negatives].map(row => row[field]))].sort((a, b) => a - b);
  const cuts = [0, ...values.map((value, index) => index === 0 ? value / 2 : (value + values[index - 1]) / 2), 1];
  return cuts.map(threshold => {
    const tp = positives.filter(row => row[field] > threshold).length;
    const fn = positives.length - tp;
    const fp = negatives.filter(row => row[field] > threshold).length;
    const tn = negatives.length - fp;
    const tpr = positives.length ? tp / positives.length : 0;
    const fpr = negatives.length ? fp / negatives.length : 0;
    return { threshold, tp, fn, fp, tn, tpr, fpr, youden: tpr - fpr };
  });
}

// Rank-based AUROC (Mann-Whitney U), ties counted at half weight.
function auroc(positives, negatives, field) {
  if (!positives.length || !negatives.length) return null;
  let wins = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive[field] > negative[field]) wins += 1;
      else if (positive[field] === negative[field]) wins += 0.5;
    }
  }
  return wins / (positives.length * negatives.length);
}

const quantiles = (rows, field) => {
  const values = rows.map(row => row[field]).sort((a, b) => a - b);
  const at = (q) => values.length ? values[Math.min(values.length - 1, Math.floor(q * values.length))] : null;
  return { min: values[0] ?? null, p05: at(0.05), p50: at(0.5), p95: at(0.95), max: values[values.length - 1] ?? null };
};

const documents = Number(process.env.SCCE_CALIBRATION_DOCUMENTS ?? 120);
const pairsPerDocument = Number(process.env.SCCE_CALIBRATION_PAIRS ?? 6);
const seed = process.env.SCCE_CALIBRATION_SEED ?? "proof-calibration-v1";

const proof = createSemanticProofSystem({ hasher: createHasher() });
const { positives, negatives } = minimalPairs();
const corpus = await corpusNegatives(documents, pairsPerDocument, seed).catch(error => {
  process.stderr.write(`corpus negatives unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
  return [];
});

const allScoredPositives = scorePairs(proof, positives);
const allScoredConstructedNegatives = scorePairs(proof, negatives);
const allScoredCorpusNegatives = scorePairs(proof, corpus);
const rejectedByPredicateRule = [...allScoredPositives, ...allScoredConstructedNegatives, ...allScoredCorpusNegatives]
  .filter(row => !row.admitted).length;
const scoredPositives = allScoredPositives.filter(row => row.admitted);
const scoredConstructedNegatives = allScoredConstructedNegatives.filter(row => row.admitted);
const scoredCorpusNegatives = allScoredCorpusNegatives.filter(row => row.admitted);
const allNegatives = [...scoredConstructedNegatives, ...scoredCorpusNegatives];

// Support is a separate question with its own labels: does this evidence bear on this claim at all? Positives are the
// same fact restated in different words (the evidence a real answer rests on); negatives pair a claim with a fact
// about a different subject. The 0.12 admission cut for a DIRECT proof step is read off this, not off intuition.
// Each entry states ONE fact two ways. The pair (a,b) is a support positive because it is the same proposition
// reworded; any (a_i, b_j) with i != j is a support negative because the two facts share no subject, predicate or
// value. Generating both classes from one table is what makes them symmetric -- the negatives are exactly as
// well-formed and as long as the positives, so a threshold cannot separate them on surface shape alone.
const FACT_PAIRS = [
  ["The Drennish reactor was commissioned on 11 April 1988.", "Commissioning of the Drennish reactor took place on 11 April 1988."],
  ["Xylor-7 decomposes at 417 degrees Celsius.", "Decomposition of Xylor-7 occurs at 417 degrees Celsius."],
  ["Alice Renner became chief executive of Halvern Dynamics in 2019.", "In 2019 Alice Renner was appointed chief executive of Halvern Dynamics."],
  ["The summit of Mount Verrick is 3412 metres above sea level.", "Mount Verrick rises to 3412 metres above sea level at its summit."],
  ["Factory A had 12 machines.", "There were 12 machines at Factory A."],
  ["The Ostry tunnel was opened on 14 June 1972.", "Opening of the Ostry tunnel occurred on 14 June 1972."],
  ["The Marlin bridge was completed on 27 January 1980.", "Completion of the Marlin bridge came on 27 January 1980."],
  ["The Halvern furnace operates at 220 kilopascals.", "Operating pressure of the Halvern furnace is 220 kilopascals."],
  ["The Renner aquifer yields 58 litres per second.", "A yield of 58 litres per second comes from the Renner aquifer."],
  ["The Calder observatory was dedicated on 3 September 1991.", "Dedication of the Calder observatory happened on 3 September 1991."],
  ["The Ostry depot stored 9 railcars.", "There were 9 railcars stored at the Ostry depot."],
  ["Boreth Station reported 46 millimetres of rainfall.", "Rainfall of 46 millimetres was reported at Boreth Station."]
];
const SUPPORTED = FACT_PAIRS.map(([a, b]) => [a, b]);
const UNSUPPORTED = FACT_PAIRS.flatMap(([a], i) =>
  FACT_PAIRS.filter((_, j) => j !== i).map(([, b]) => [a, b]));
const supportPositives = scorePairs(proof, SUPPORTED.map(([a, b]) => ({ kind: "restated-fact", a, b }))).filter(row => row.admitted);
// Only constructed pairs are used as support negatives. Two sentences from one article frequently DO bear on each
// other, so labelling them "unsupported" would be inventing a label rather than observing one -- they stay in the
// contradiction set, where "one document is internally consistent" is a defensible presumption, and out of this one.
const supportNegatives = scorePairs(proof, UNSUPPORTED.map(([a, b]) => ({ kind: "unrelated-fact", a, b })))
  .filter(row => row.admitted);
const supportCurve = sweep(supportPositives, supportNegatives, "support");
const supportSeparable = supportCurve.filter(row => row.fn === 0 && row.fp === 0);
const supportFullRecall = supportCurve.filter(row => row.tpr === 1);

const curve = sweep(scoredPositives, allNegatives, "contradiction");
const separable = curve.filter(row => row.fn === 0 && row.fp === 0);
const bestYouden = [...curve].sort((a, b) => b.youden - a.youden || b.threshold - a.threshold)[0];
// A false positive here suppresses a correct answer (measured: eight fabricated conflicts blocked the Charles
// Babbage excerpt), so the operating point is the HIGHEST threshold that still catches every real disagreement.
const maxTprCuts = curve.filter(row => row.tpr === 1);
const conservative = maxTprCuts.length ? maxTprCuts[maxTprCuts.length - 1] : bestYouden;

const report = {
  schema: "scce.proofCalibration.v1",
  seed,
  generatedFrom: { constructedPositives: scoredPositives.length, constructedNegatives: scoredConstructedNegatives.length, corpusNegatives: scoredCorpusNegatives.length, corpusDocuments: documents, rejectedByPredicateRule },
  current: { PROOF_CONTRADICTION_THRESHOLD },
  auroc: { contradiction: auroc(scoredPositives, allNegatives, "contradiction") },
  distributions: {
    positives: quantiles(scoredPositives, "contradiction"),
    constructedNegatives: quantiles(scoredConstructedNegatives, "contradiction"),
    corpusNegatives: quantiles(scoredCorpusNegatives, "contradiction")
  },
  separableWindow: separable.length ? { low: separable[0].threshold, high: separable[separable.length - 1].threshold } : null,
  operatingPoints: { youden: bestYouden, highestThresholdAtFullRecall: conservative },
  atCurrentThreshold: curve.reduce((best, row) => Math.abs(row.threshold - PROOF_CONTRADICTION_THRESHOLD) < Math.abs(best.threshold - PROOF_CONTRADICTION_THRESHOLD) ? row : best, curve[0]),
  support: {
    counts: { positives: supportPositives.length, negatives: supportNegatives.length },
    auroc: auroc(supportPositives, supportNegatives, "support"),
    distributions: { positives: quantiles(supportPositives, "support"), negatives: quantiles(supportNegatives, "support") },
    separableWindow: supportSeparable.length ? { low: supportSeparable[0].threshold, high: supportSeparable[supportSeparable.length - 1].threshold } : null,
    highestThresholdAtFullRecall: supportFullRecall.length ? supportFullRecall[supportFullRecall.length - 1] : null,
    atCurrentThreshold: supportCurve.reduce((best, row) => Math.abs(row.threshold - 0.12) < Math.abs(best.threshold - 0.12) ? row : best, supportCurve[0])
  },
  // The CONTRADICTED verdict requires contradiction >= 0.55. Reported against the measured positive distribution
  // because a verdict cut above the median of real disagreements silently declines to call them contradictions.
  verdictCut: {
    value: 0.55,
    truePositivesReaching: scoredPositives.filter(row => row.contradiction >= 0.55).length,
    truePositivesTotal: scoredPositives.length
  },
  worstFalsePositives: [...allNegatives].sort((a, b) => b.contradiction - a.contradiction).slice(0, 8)
    .map(row => ({ kind: row.kind, contradiction: Number(row.contradiction.toFixed(4)), correspondence: Number(row.correspondence.toFixed(4)), a: row.a.slice(0, 110), b: row.b.slice(0, 110) })),
  weakestTruePositives: [...scoredPositives].sort((a, b) => a.contradiction - b.contradiction).slice(0, 8)
    .map(row => ({ kind: row.kind, contradiction: Number(row.contradiction.toFixed(4)), correspondence: Number(row.correspondence.toFixed(4)), a: row.a.slice(0, 110), b: row.b.slice(0, 110) }))
};

const outPath = process.env.SCCE_CALIBRATION_OUT ?? "tools/proof-calibration/report.json";
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 1)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
