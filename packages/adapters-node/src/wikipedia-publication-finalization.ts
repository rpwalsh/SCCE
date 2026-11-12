// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  canonicalStringify,
  createHasher,
  pendingWikipediaPublicationQualification,
  qualifyWikipediaPublicationCandidate,
  toJsonValue,
  wikipediaSourceCompilationInventoryHash,
  type BrainLifecycleRecord,
  type BrainValidationReport,
  type ContentHash,
  type Hasher,
  type ScceStorage,
  type WikipediaPublicationQualificationResult,
  type WikipediaPublicationReceiptReference,
  type WikipediaSourceCompilationInventoryEntry
} from "@scce/kernel";

export interface WikipediaPublicationEvidence {
  executableHash: string;
  configurationHash: string;
  policyHash: string;
  casesHash: string;
  sourceCompilations: readonly WikipediaSourceCompilationInventoryEntry[];
  receipts: readonly WikipediaPublicationReceiptReference[];
}

export interface WikipediaPublicationFinalizationResult {
  lifecycle: BrainLifecycleRecord;
  qualification: WikipediaPublicationQualificationResult;
  pending: boolean;
}

/**
 * Persist one publication verdict and perform only the existing lifecycle CAS.
 * Missing evidence is a durable pending failure that intentionally leaves the
 * candidate VALIDATING. Supplied-but-invalid evidence is a terminal FAILED
 * validation. Only a PASSED report can advance VALIDATING to READY.
 */
export async function finalizeWikipediaCandidatePublication(input: {
  storage: Pick<ScceStorage, "blobs" | "brainImports">;
  lifecycle: BrainLifecycleRecord;
  evidence?: WikipediaPublicationEvidence;
  validatedAt: number;
  hasher?: Hasher;
}): Promise<WikipediaPublicationFinalizationResult> {
  if (input.lifecycle.state !== "VALIDATING") {
    throw new Error(`Wikipedia publication qualification requires VALIDATING, received ${input.lifecycle.state}`);
  }
  const hasher = input.hasher ?? createHasher();
  const qualification = input.evidence
    ? await qualifyWikipediaPublicationCandidate({
      lifecycleState: input.lifecycle.state,
      manifest: input.lifecycle.manifest,
      binding: {
        importRunId: input.lifecycle.importRunId,
        brainVersion: input.lifecycle.brainVersion,
        manifestHash: input.lifecycle.manifest.manifestHash,
        inventoryHash: wikipediaSourceCompilationInventoryHash(input.evidence.sourceCompilations, hasher),
        executableHash: input.evidence.executableHash,
        configurationHash: input.evidence.configurationHash,
        policyHash: input.evidence.policyHash,
        casesHash: input.evidence.casesHash
      },
      sourceCompilations: input.evidence.sourceCompilations,
      receipts: input.evidence.receipts,
      readContent: async contentHash => input.storage.blobs.get(contentHash as ContentHash),
      validatedAt: input.validatedAt,
      hasher
    })
    : pendingWikipediaPublicationQualification({
      manifest: input.lifecycle.manifest,
      lifecycleState: input.lifecycle.state,
      validatedAt: input.validatedAt
    });
  await persistQualificationReport(input.storage, input.lifecycle, qualification.report, input.evidence === undefined, hasher);
  if (!input.evidence) return { lifecycle: input.lifecycle, qualification, pending: true };
  const lifecycle = await input.storage.brainImports.transitionLifecycle({
    importRunId: input.lifecycle.importRunId,
    expectedState: "VALIDATING",
    toState: qualification.qualified ? "READY" : "FAILED",
    updatedAt: input.validatedAt,
    reason: qualification.qualified
      ? "Wikipedia publication qualification passed"
      : `Wikipedia publication qualification failed: ${qualification.rejection.checkId}`,
    validation: qualification.report
  });
  return { lifecycle, qualification, pending: false };
}

async function persistQualificationReport(
  storage: Pick<ScceStorage, "brainImports">,
  lifecycle: BrainLifecycleRecord,
  report: BrainValidationReport,
  pending: boolean,
  hasher: Hasher
): Promise<void> {
  const reportHash = hasher.digestHex(canonicalStringify(report));
  await storage.brainImports.putLedger({
    id: `wikipedia.publication.qualification.${reportHash}`,
    importRunId: lifecycle.importRunId,
    brainVersion: lifecycle.brainVersion,
    rootPath: lifecycle.rootPath,
    sectionId: "__publication_qualification__",
    sectionKind: "manifest",
    forceClass: "learned_concept_prior",
    fileHash: lifecycle.manifest.manifestHash,
    shardHash: reportHash,
    evidenceIds: [],
    nodeIds: [],
    rowCounts: {},
    warnings: pending ? ["publication qualification pending"] : report.disposition === "PASSED" ? [] : ["publication qualification failed"],
    metadata: toJsonValue({ pending, validation: report }),
    importedAt: report.validatedAt
  });
}
