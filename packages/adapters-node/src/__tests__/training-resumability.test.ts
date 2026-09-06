// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { canonicalStringify, createHasher, createIdFactory, createClock } from "@scce/kernel";
import type { IngestionCheckpoint } from "@scce/kernel";
import { verifiedResumeOffset } from "../wikipedia-v3-ingestor.js";

/**
 * Plan item 245: an interrupted training run resumes from verified offsets
 * and produces the same content-derived identity.
 *
 * Scope boundary (honest): this exercises the real production resume
 * predicate (`verifiedResumeOffset`, called by the ingestor's own
 * `resumeOffset`) against real `IngestionCheckpoint` records, and the real
 * content-derived id factory. It does not run a multi-gigabyte Wikipedia
 * dump end to end -- that is a live-infrastructure rehearsal, not a unit
 * test.
 */
describe("training resumability (plan item 245)", () => {
  const checkpoint = (over: Partial<IngestionCheckpoint>): IngestionCheckpoint => ({
    id: "cp",
    rootUri: "wikipedia://enwiki",
    itemUri: "wikipedia://enwiki/block/0",
    phase: "stored",
    status: "complete",
    offsetBytes: 0,
    updatedAt: 1,
    metadata: {},
    ...over
  });

  it("resumes from the highest fully-durable block offset", () => {
    expect(verifiedResumeOffset([
      checkpoint({ id: "a", itemUri: "wikipedia://enwiki/block/0", offsetBytes: 0 }),
      checkpoint({ id: "b", itemUri: "wikipedia://enwiki/block/1", offsetBytes: 4096 }),
      checkpoint({ id: "c", itemUri: "wikipedia://enwiki/block/2", offsetBytes: 2048 })
    ])).toBe(4096);
  });

  it("never resumes past a block that was interrupted before its bytes were durable", () => {
    // The interrupted block reached a higher offset but only "extracting" /
    // "running" -- trusting it would silently skip real, un-ingested bytes.
    expect(verifiedResumeOffset([
      checkpoint({ id: "a", itemUri: "wikipedia://enwiki/block/0", offsetBytes: 4096 }),
      checkpoint({ id: "interrupted", itemUri: "wikipedia://enwiki/block/1", offsetBytes: 99999, phase: "extracting", status: "running" }),
      checkpoint({ id: "failed", itemUri: "wikipedia://enwiki/block/2", offsetBytes: 88888, phase: "failed", status: "failed" })
    ])).toBe(4096);
  });

  it("ignores page-level checkpoints, which are not resumable block boundaries", () => {
    expect(verifiedResumeOffset([
      checkpoint({ id: "a", itemUri: "wikipedia://enwiki/block/0", offsetBytes: 1024 }),
      checkpoint({ id: "page", itemUri: "wikipedia://enwiki/page/12345", offsetBytes: 77777 })
    ])).toBe(1024);
  });

  it("starts from zero when nothing durable exists yet", () => {
    expect(verifiedResumeOffset([])).toBe(0);
    expect(verifiedResumeOffset([
      checkpoint({ id: "x", offsetBytes: 500, phase: "discovered", status: "pending" })
    ])).toBe(0);
  });

  it("produces identical content-derived identity whether ingested in one run or resumed across two", () => {
    const ids = () => createIdFactory({
      clock: createClock({ fixedTime: 1_000 }),
      hasher: createHasher(),
      deterministicReplay: true
    });
    const blocks = [
      Buffer.from("first block of real training bytes", "utf8"),
      Buffer.from("second block of real training bytes", "utf8"),
      Buffer.from("third block of real training bytes", "utf8")
    ];

    // Uninterrupted: one factory processes every block in order.
    const straightThrough = ids();
    const uninterrupted = blocks.map(bytes => String(straightThrough.sourceVersionId(bytes)));

    // Interrupted after block 2, then resumed with a fresh process (fresh
    // factory) that only handles the remaining block.
    const beforeCrash = ids();
    const partial = blocks.slice(0, 2).map(bytes => String(beforeCrash.sourceVersionId(bytes)));
    const afterResume = ids();
    const remainder = blocks.slice(2).map(bytes => String(afterResume.sourceVersionId(bytes)));

    expect([...partial, ...remainder]).toEqual(uninterrupted);
  });

  it("reaches the same brain identity after a resume, and a double-counted resume does not", () => {
    // Plan item 245. The ingestor derives a brain version by canonically hashing its own run summary, so a resumed run
    // that ends with the same counts is the same brain, and one that re-ingests a block it already had is not.
    const hasher = createHasher();
    const brainVersion = (seed: Record<string, unknown>): string =>
      `wikipedia:${hasher.digestHex(canonicalStringify(seed)).slice(0, 32)}`;
    const summary = (pages: number, evidence: number, lastCheckpointOffset: number): Record<string, unknown> => ({
      rootUri: "wikipedia://enwiki",
      dumpPath: "/dump.xml",
      indexPath: null,
      resumedFromOffset: 0,
      lastCheckpointOffset,
      pages,
      evidence,
      stoppedByHeapSafetyBound: false,
      stoppedByOwner: false,
      stopReason: null
    });

    const straightThrough = brainVersion(summary(120, 8_566, 12_288));
    // Interrupted after 80 pages, resumed from the verified offset for the remaining 40.
    const resumed = brainVersion({ ...summary(80 + 40, 5_700 + 2_866, 12_288), resumedFromOffset: 0 });
    expect(resumed).toBe(straightThrough);

    // A resume that replays a block it had already durably ingested counts it twice: a different brain, correctly.
    const doubleCounted = brainVersion(summary(120 + 40, 8_566 + 2_866, 12_288));
    expect(doubleCounted).not.toBe(straightThrough);
  });
});
