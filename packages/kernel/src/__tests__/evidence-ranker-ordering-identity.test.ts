// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { localEvidenceAnswerSurface, proposeSourceExactEvidenceAnswer } from "../local-evidence-runtime.js";
import type { EvidenceId, EvidenceSpan, SourceVersionId } from "../types.js";

/**
 * Two separate implementations of the same ranking contract exist: `bestEvidenceSentences` (behind
 * localEvidenceAnswerSurface) and proposeSourceExactEvidenceAnswer's own. They differ in thirteen measured
 * ways, including which calibration ids weight them, so merging them is a corpus-wide ranking change and not a
 * refactor -- see T52. This pins what each of them ORDERS, over real promoted corpus leads, so that merge can
 * be PROVEN to change no ordering rather than asserted to, and so neither drifts in the meantime. Regenerate
 * deliberately with SCCE_WRITE_RANKER_SNAPSHOT=1; a silent regeneration is what would make it worthless.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, "fixtures", "ranker-corpus.json"), "utf8")) as {
  spans: { id: string; title: string; alpha: number; text: string }[];
  requests: string[];
  closedClassWords: string[];
};
const snapshotPath = join(here, "fixtures", "ranker-ordering-snapshot.json");
const CLOSED_CLASS = new Set(corpus.closedClassWords);

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function span(row: { id: string; title: string; alpha: number; text: string }): EvidenceSpan {
  return {
    id: row.id as EvidenceId,
    sourceVersionId: `${row.id}:v1` as SourceVersionId,
    text: row.text,
    textPreview: row.text,
    status: "promoted",
    alpha: row.alpha,
    charStart: 0,
    features: [],
    provenance: {
      uri: `fixture://${row.id}`,
      title: row.title,
      sourceVersionId: `${row.id}:v1`,
      byteRange: [0, row.text.length],
      charRange: [0, row.text.length],
      metadata: { title: row.title }
    }
  } as unknown as EvidenceSpan;
}

/** The ranked list `local_evidence.plan.rank` reports, which is the ordering the live measurements read. */
function planRanking(requestText: string, spans: readonly EvidenceSpan[]): string[] {
  const directory = mkdtempSync(join(tmpdir(), "scce-rank-identity-"));
  directories.push(directory);
  const handle = { traceId: "ranker-identity", file: join(directory, "rank.jsonl") };
  const globals = globalThis as { __sccTrace?: unknown };
  globals.__sccTrace = handle;
  try {
    localEvidenceAnswerSurface({ requestText, selectedEvidence: spans, closedClassWords: CLOSED_CLASS });
  } finally {
    delete globals.__sccTrace;
  }
  let rows: { stage: string; support?: { ranked?: string[] } }[] = [];
  try {
    rows = readFileSync(handle.file, "utf8").trim().split("\n").filter(Boolean)
      .map(line => JSON.parse(line) as { stage: string; support?: { ranked?: string[] } });
  } catch {
    return [];
  }
  return rows.find(row => row.stage === "local_evidence.plan.rank")?.support?.ranked ?? [];
}

/** What the source-exact ranker's own ordering selected, with the score and source position it selected on. */
function proposalSelection(requestText: string, spans: readonly EvidenceSpan[]): unknown {
  const proposal = proposeSourceExactEvidenceAnswer({ requestText, selectedEvidence: spans, closedClassWords: CLOSED_CLASS });
  if (!proposal) return null;
  const audit = proposal.plan.audit as Record<string, unknown>;
  return {
    sentences: Object.values(proposal.plan.slotSurfaces).flat(),
    score: audit.proposalScore,
    index: audit.proposalSentenceIndex,
    nearDuplicate: audit.nearDuplicate,
    evidenceIds: audit.evidenceIds
  };
}

function measure(): Record<string, unknown> {
  const spans = corpus.spans.map(span);
  const measured: Record<string, unknown> = {};
  for (const requestText of corpus.requests) {
    // Each span alone, and the whole pool: cross-span source affinity only engages with siblings present.
    for (const [label, pool] of [["pool", spans] as const, ...spans.map((one, index) => [`span${index}`, [one]] as const)]) {
      measured[`${requestText} :: ${label}`] = {
        planRanking: planRanking(requestText, pool),
        proposal: proposalSelection(requestText, pool)
      };
    }
  }
  return measured;
}

describe("both sentence rankers order the corpus exactly as recorded", () => {
  it("matches the recorded ordering for every request and pool", () => {
    const measured = measure();
    if (process.env.SCCE_WRITE_RANKER_SNAPSHOT === "1") {
      writeFileSync(snapshotPath, `${JSON.stringify(measured, undefined, 2)}\n`, "utf8");
    }
    const recorded = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(measured).length).toBeGreaterThan(0);
    expect(measured).toEqual(recorded);
  });
});
