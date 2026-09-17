// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { localEvidenceAnswerSurface } from "../local-evidence-runtime.js";
import type { EvidenceId, EvidenceSpan, SourceVersionId } from "../types.js";

/**
 * The sentence that SUPPLIES the value the request's relation binds must outrank the sentence that only repeats
 * the relation word. Measured live on "When was Ada Lovelace born?" (`local_evidence.rank_features`): the lead
 * stating "10 December 1815" scored unitOverlap 0 -- the value is not the word "born" -- while "Lord Byron
 * separated from his wife a month after Ada was born" scored 1 and took the title-lead boost, so
 * `local_evidence.plan.rank` proposed it. The same turn's realization contract had already resolved the value.
 * Asserted on the ranker's own traced ordering, which is the quantity that was measured live.
 */

// Verbatim prefix of evidence_span.87ae75525ff8b0973cbf3ff726d708fe6a419a06116fe801 (char_start 0, promoted).
const ADA_LEAD = "'Augusta Ada King, Countess of Lovelace' ( ; 10 December 1815 – 27 November 1852), also known as "
  + "'Ada Lovelace', was an English mathematician and writer chiefly known for work on Charles Babbage's proposed "
  + "mechanical general-purpose computer, the analytical engine. She was the first to recognise the machine had "
  + "applications beyond pure calculation. Lovelace is often considered the first computer programmer. Lovelace "
  + "was the only legitimate child of poet Lord Byron and reformer Anne Isabella Milbanke. Lord Byron separated "
  + "from his wife a month after Ada was born, and died when she was eight. Although often ill in childhood, "
  + "Lovelace pursued her studies assiduously. She married William King in 1835.";

const REQUEST = "When was Ada Lovelace born?";
const CLOSED_CLASS = new Set(["when", "was", "the", "of", "in", "and", "a", "to", "her", "she", "his", "he", "from", "after"]);
/** The value `candidate.realization_contract` carried on the same live turn whose proposal was the Byron sentence. */
const CONTRACT_VALUE = "10 December 1815";
/** The relation unit the request asks about. The sentence that only repeats it is the one that used to win. */
const RELATION_UNIT = "born";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function adaSpan(): EvidenceSpan {
  return {
    id: "evidence_span.ada_lovelace_lead" as EvidenceId,
    sourceVersionId: "evidence_span.ada_lovelace_lead:v1" as SourceVersionId,
    text: ADA_LEAD,
    textPreview: ADA_LEAD,
    status: "promoted",
    alpha: 0.7252110282556066,
    charStart: 0,
    features: [],
    provenance: {
      uri: "fixture://ada-lovelace",
      title: "Ada Lovelace",
      sourceVersionId: "evidence_span.ada_lovelace_lead:v1",
      byteRange: [0, ADA_LEAD.length],
      charRange: [0, ADA_LEAD.length],
      metadata: { title: "Ada Lovelace" }
    }
  } as unknown as EvidenceSpan;
}

/** The sentences `local_evidence.plan.rank` reports, in ranked order: what the live measurement read. */
function rankedSentences(boundValues?: readonly string[]): string[] {
  const directory = mkdtempSync(join(tmpdir(), "scce-rank-"));
  directories.push(directory);
  const handle = { traceId: "bound-value-rank", file: join(directory, "rank.jsonl") };
  const globals = globalThis as { __sccTrace?: unknown };
  globals.__sccTrace = handle;
  try {
    localEvidenceAnswerSurface({
      requestText: REQUEST,
      selectedEvidence: [adaSpan()],
      closedClassWords: CLOSED_CLASS,
      ...(boundValues ? { boundValues } : {})
    });
  } finally {
    delete globals.__sccTrace;
  }
  const rows = readFileSync(handle.file, "utf8").trim().split("\n")
    .map(line => JSON.parse(line) as { stage: string; support?: { ranked?: string[] } });
  return rows.find(row => row.stage === "local_evidence.plan.rank")?.support?.ranked ?? [];
}

describe("a sentence supplying the request's bound value outranks one that only repeats the relation word", () => {
  it("leads with the value-bearing sentence once the contract has resolved a value", () => {
    const measured = rankedSentences([CONTRACT_VALUE]);
    expect(measured.length).toBeGreaterThan(0);
    // Stated over the measured quantities, not over a fixed string: the leading sentence is the one binding the
    // request's relation to the value the contract resolved, and the sentence that only repeats the relation unit
    // while supplying no value no longer reaches the plan at all.
    expect(measured[0]).toContain(CONTRACT_VALUE);
    expect(measured.filter(sentence => sentence.includes(RELATION_UNIT) && !sentence.includes(CONTRACT_VALUE))).toEqual([]);
  });

  it("ranks exactly as it does today when no candidate supplies a bound value", () => {
    // Law 1: absence of measurement is not negative evidence. A turn whose contract resolved nothing, and a turn
    // whose resolved value appears in no candidate, must both rank byte-identically to today.
    const unmeasured = rankedSentences();
    expect(unmeasured.length).toBeGreaterThan(0);
    // The losing side, kept so the fix cannot be removed quietly: with nothing bound, the relation-repeating
    // sentence is what the plan ranks and the value is nowhere in it.
    expect(unmeasured.some(sentence => sentence.includes(RELATION_UNIT))).toBe(true);
    expect(unmeasured.some(sentence => sentence.includes(CONTRACT_VALUE))).toBe(false);
    expect(rankedSentences([])).toEqual(unmeasured);
    expect(rankedSentences(["a value no sentence of this span contains"])).toEqual(unmeasured);
  });
});
