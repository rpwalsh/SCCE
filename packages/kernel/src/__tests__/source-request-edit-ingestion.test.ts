// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { createIngestionRuntime } from "../ingestion-runtime.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createClock, createHasher, toJsonValue } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { createEventFactory } from "../events.js";
import { learnedSourceRequestEditForText, SOURCE_REQUEST_EDIT_SCHEMA, SOURCE_REQUEST_EDIT_RECIPE } from "../source-request-edit-program.js";
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";
import type { EvidenceSpan } from "../types.js";
import type { ScceKernelDeps } from "../storage.js";
import type { TranscriptTurn } from "../dialogue-communicative-act-learning.js";

it("preserves ordinary source annotations without self-certifying multiple records as independent sources", async () => {
  const hasher = createHasher(), clock = createClock({ fixedTime: 1700000000000, stepMs: 1 });
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "request-edit-ingestion" });
  const evidence: EvidenceSpan[] = [], fixture = storageFixtureForEvaluation({ evidence, clockNow: clock.now });
  fixture.storage.evidence.putEvidenceSpan = async span => { evidence.push(span); };
  const bytesByHash = new Map<string, Uint8Array>();
  fixture.storage.blobs.put = async bytes => { const hash = ids.contentHash(bytes); bytesByHash.set(String(hash), new Uint8Array(bytes)); return hash; };
  fixture.storage.blobs.putRanges = async (ranges, parent) => {
    for (const range of ranges) {
      const bytes = parent.bytes.subarray(range.byteStart, range.byteEnd);
      expect(ids.contentHash(bytes)).toBe(range.contentHash); bytesByHash.set(String(range.contentHash), new Uint8Array(bytes));
    }
  };
  const label = { tenantId: "fixture.tenant", principals: ["fixture.owner"], compartments: ["fixture.ingestion"],
    exportClass: "restricted" as const, mergePolicy: "isolated" as const };
  const deps = { storage: fixture.storage, maxChunkBytes: 4096, sourceInformationLabel: label,
    informationAccess: { tenantId: "fixture.tenant", principalId: "fixture.owner", compartments: ["fixture.ingestion"], maximumExportClass: "restricted" } } as ScceKernelDeps;
  const runtime = createIngestionRuntime({ deps, clock, hasher, idFactory: ids, eventFactory: createEventFactory({ idFactory: ids, clock, hasher }),
    language: createLanguageAcquisitionEngine({ idFactory: ids }), languageMemoryRuntime: createLanguageMemoryRuntime({ idFactory: ids, hasher }),
    append: async event => { fixture.events.push(event); return event; }, onKernelStateMutation: () => undefined });
  const turns: TranscriptTurn[] = []; let text = "";
  for (const [index, [left, value, right]] of [["甲", "赤", "乙"], ["丙", "青", "丁"], ["戊", "緑", "己"]].entries()) {
    const request = `操作「${left}◇${right}」`, reply = `${left}${value}${right}`;
    const start = [...text].length, replyStart = start + [...request].length + 1;
    text += request + "\n" + reply + "\n";
    turns.push({ index: index * 2, speakerId: "user", sourceRecordId: `independent.record.${index}`, surface: request,
      startCodePoint: start, endCodePoint: start + [...request].length },
    { index: index * 2 + 1, speakerId: "assistant", sourceRecordId: `independent.record.${index}`, surface: reply,
      replyToTurnIndex: index * 2, commitmentScope: "external", startCodePoint: replyStart, endCodePoint: replyStart + [...reply].length });
  }
  await runtime.ingest({ uri: "inline://learned-edit-pairs", namespace: "fixture", content: text, mediaType: "text/plain",
    metadata: toJsonValue({ authorship: "human_authored", transcriptTurns: turns }),
    sourceAdmission: { sourceClass: "owner_local", intendedUse: "learned_prior", promotionAuthority: "owner" },
    sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
      independenceGroup: "fixture", accessScope: "owner_private", licenseStatus: "owner_authorized" } });
  const patterns = await fixture.storage.languageMemory.listLanguagePatterns({ patternSchemas: [SOURCE_REQUEST_EDIT_SCHEMA] });
  expect(patterns).toHaveLength(0);
  const source = evidence.find(span => span.text === text)!;
  expect(source).toBeDefined();
  const learned = await learnedSourceRequestEditForText({ storage: fixture.storage, requestText: "操作「🪐한국◇終端」" });
  expect(learned).toBeUndefined();
  expect(Buffer.from(bytesByHash.get(String(source.contentHash))!).toString("utf8")).toBe(text);
});
