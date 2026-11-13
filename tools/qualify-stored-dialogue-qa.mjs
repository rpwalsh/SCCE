#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";

export async function qualifyStoredDialogueQa({ storage, kernel, readArchive, execute, options }) {
  const hasher = kernel.createHasher();
  const rows = await storage.evidence.listEvidenceBackedSourceVersions({
    includeUriPrefixes: [options.includeUriPrefix], excludeTrainingDerived: true,
    orderBySourceVersionId: true, limit: options.maxSources + 1
  });
  if (rows.length > options.maxSources) throw Error("Retained source selection exceeds max-sources; no partial qualification");
  const identities = await storage.languageIdentities.listIdentities();
  const documents = [], sourceReceipts = [];
  let totalBytes = 0;
  for (const row of rows) {
    totalBytes += Number(row.byteLength);
    if (totalBytes > options.maxTotalBytes) throw Error("Retained source selection exceeds max-total-bytes");
    const source = await storage.evidence.sourceVersionById(row.sourceVersionId);
    if (!source) throw Error("Retained source version is missing");
    const text = Buffer.from(await storage.blobs.get(source.contentHash)).toString("utf8");
    const transcriptTurns = await readArchive(storage, source, text);
    if (!transcriptTurns) throw Error("Retained source lacks its transcript archive");
    const profiles = await storage.model.listLanguageProfiles({ sourceVersionIds: [row.sourceVersionId], limit: 2 });
    if (profiles.length !== 1) throw Error("Retained source requires one exact profile");
    const profileId = profiles[0].id;
    const assignments = await storage.languageIdentities.listProfileLanguages({ profileIds: [profileId] });
    if (assignments.length !== 1) throw Error("Retained source requires one exact language identity");
    const languageIdentityId = assignments[0].languageId;
    const identity = identities.find(value => value.id === languageIdentityId);
    if (!identity || identity.schema !== kernel.LANGUAGE_IDENTITY_SCHEMA || !identity.evidence
      || identity.evidence.status === "source_observed" || !identity.informationLabel) throw Error("Retained identity is unqualified");
    const spans = (await storage.evidence.searchEvidence({
      sourceVersionId: row.sourceVersionId, status: "promoted", limit: 4096
    })).map(value => value.span);
    if (!spans.length || spans.some(span => String(span.sourceVersionId) !== String(row.sourceVersionId)
      || kernel.canonicalStringify(span.informationLabel) !== kernel.canonicalStringify(identity.informationLabel))) {
      throw Error("Retained evidence ownership does not match its language identity");
    }
    const languageIdentityDigest = hasher.digestHex(kernel.canonicalStringify({
      schema: "scce.contextual_qa_language_identity_assignment.v1", profileId, languageIdentityId, identity
    }));
    documents.push({ sourceVersionId: String(row.sourceVersionId), profileId, languageIdentityId, languageIdentityDigest,
      spans, transcriptTurns });
    sourceReceipts.push({ sourceVersionId: String(row.sourceVersionId), contentHash: String(source.contentHash),
      canonicalUri: row.canonicalUri, transcriptDigest: hasher.digestHex(kernel.canonicalStringify(transcriptTurns)),
      pairs: transcriptTurns.filter(turn => turn.replyToTurnIndex !== undefined).length });
  }
  const { result, receipt } = await execute({ documents, updatedAt: 1, authorship: "human_authored", execution: options.execution });
  const reasons = {};
  for (const rejection of result.rejected) reasons[rejection.reason] = (reasons[rejection.reason] ?? 0) + 1;
  const evidence = documents.flatMap(document => document.spans);
  const families = result.families.map(family => {
    const metadata = family.pattern.patternJson;
    const verified = kernel.verifyContextualQaConstruction({ pattern: family.pattern, evidence, hasher });
    return { patternId: family.pattern.id, method: metadata.contextualQaQualification?.method,
      requestForm: metadata.contextualQaRequestForm, applicability: family.applicability, verified: Boolean(verified),
      witnessPartitions: metadata.contextualQaQualification?.partitions,
      heldOutReplays: verified && metadata.contextualQaQualification?.method === "leave_one_source_family_out.v1"
        ? replayQualifiedSourceFamilies({ kernel, hasher, bundle: verified, metadata, evidence }) : [] };
  });
  return { schema: "scce.stored_dialogue_qa_qualification.v1", mode: "read_only", sourceSelectionComplete: true,
    transcriptFiltering: false, sourceReceipts, totalBytes, pairs: result.pairs, execution: receipt,
    verifiedFamilies: families.filter(family => family.verified).length,
    transferQualifiedFamilies: families.filter(family => family.verified && family.method === "leave_one_source_family_out.v1").length,
    families, rejectedByReason: reasons };
}

export function replayQualifiedSourceFamilies({ kernel, hasher, bundle, metadata, evidence }) {
  const witnesses = metadata.contextualQaQualification.witnesses;
  const partitions = [...new Set(witnesses.map(witness => witness.sourceFamilyId ?? witness.sourceRecordId))].sort();
  return partitions.flatMap(partition => {
    const held = witnesses.filter(witness => (witness.sourceFamilyId ?? witness.sourceRecordId) === partition);
    const training = bundle.sourceExamples.filter(example => !held.some(witness => example.evidenceId === witness.evidenceId
      && (example.surfaceStartCodePoint >= witness.requestStart && example.surfaceEndCodePoint <= witness.requestEnd
        || example.surfaceStartCodePoint >= witness.contextStart && example.surfaceEndCodePoint <= witness.contextEnd)));
    const observations = training.map(example => ({
      sourceVersionId: example.sourceVersionId, evidenceId: example.evidenceId,
      surfaceStartCodePoint: example.surfaceStartCodePoint, surfaceEndCodePoint: example.surfaceEndCodePoint,
      roles: example.roles.map(role => ({ slotIndex: role.slotIndex, occurrenceIndex: role.occurrenceIndex,
        startCodePoint: role.startCodePoint, endCodePoint: role.endCodePoint, graphBinding: role.graphBinding })),
      nullRoles: example.nullRoles.map(role => ({ slotIndex: role.slotIndex, occurrenceIndex: role.occurrenceIndex, graphBinding: role.graphBinding })),
      ...(example.contextualQaSupervision ? { contextualQaSupervision: example.contextualQaSupervision } : {})
    }));
    const compiled = kernel.compileLanguageConstructionPattern({ bindingId: bundle.bindingId, profileId: bundle.sourceProfileId,
      evidence, observations, hasher, updatedAt: 1, acquisitionStatus: "document_heldout_qualified", storageEncoding: kernel.SOURCE_EXAMPLE_CONSTRUCTION_STORAGE });
    return held.map(witness => {
      const span = evidence.find(value => String(value.id) === witness.evidenceId);
      if (!span) throw Error("Qualified held-out witness is unavailable");
      const points = [...span.text], request = points.slice(witness.requestStart, witness.requestEnd).join("");
      const expected = points.slice(witness.replyStart, witness.replyEnd).join("");
      const context = { ...span, text: points.slice(witness.contextStart, witness.contextEnd).join(""),
        charStart: span.charStart + witness.contextStart, charEnd: span.charStart + witness.contextEnd };
      const audit = compiled.status === "compiled"
        ? kernel.sourceConstructionRequestValueResolver({ bundles: [compiled.bundle], graph: { nodes: [], hyperedges: [] } }).inspect(request, [context])
        : { status: "compile_failed" };
      return { partition, sourceRecordId: witness.sourceRecordId, request, expected, answer: audit.binding?.value,
        status: audit.status, correct: audit.binding?.value === expected, trainingExamples: training.length,
        sourceContextOnly: true, heldOutExamplesRemoved: bundle.sourceExamples.length - training.length };
    });
  });
}

async function main(args) {
  const values = new Map(args.map(argument => {
    const split = argument.indexOf("=");
    if (!argument.startsWith("--") || split < 3) throw Error("Arguments must use --name=value");
    return [argument.slice(2, split), argument.slice(split + 1)];
  }));
  const configPath = values.get("config"), includeUriPrefix = values.get("include-uri-prefix");
  if (!configPath || !includeUriPrefix) throw Error("Required: --config=path --include-uri-prefix=uri");
  const positive = (name, fallback) => {
    const value = Number(values.get(name) ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw Error("Invalid " + name);
    return value;
  };
  const adapters = await import("../packages/adapters-node/dist/index.js");
  const kernel = await import("../packages/kernel/dist/index.js");
  const { readSourceTranscriptArchive } = await import("../packages/adapters-node/dist/source-transcript-archive.js");
  const { runContextualQaAcquisition } = await import("../packages/adapters-node/dist/contextual-qa-execution.js");
  const config = await adapters.readScceRuntimeConfig(configPath);
const readOnlyUrl = new URL(config.database.url);
if (true) readOnlyUrl.searchParams.set("options",
  [readOnlyUrl.searchParams.get("options"), "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  const storage = adapters.createPostgresStorageAdapter({ ...config.database, url: readOnlyUrl.toString(), informationAccess: config.security?.informationAccess });
  try {
    const result = await qualifyStoredDialogueQa({ storage, kernel, readArchive: readSourceTranscriptArchive, execute: runContextualQaAcquisition,
      options: { includeUriPrefix, maxSources: positive("max-sources", 32), maxTotalBytes: positive("max-total-bytes", 64 * 1024 * 1024),
        execution: { backend: "node_workers.v1", workers: positive("workers", 2), workerHeapMb: positive("worker-heap-mb", 512),
          coordinatorHeapMb: positive("coordinator-heap-mb", 512), maxNodeRssBytes: positive("max-node-rss-bytes", 3 * 1024 ** 3),
          abortGraceMs: positive("abort-grace-ms", 1000) } } });
    const serialized = JSON.stringify(result, null, 2) + "\n";
    if (values.has("output")) await writeFile(values.get("output"), serialized);
    process.stdout.write(serialized);
  } finally { await storage.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
