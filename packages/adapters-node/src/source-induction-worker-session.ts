// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher, inductionCharBudget, inductionDocumentCharCap, prepareCorpusSegmentationMeasurement,
  prepareSourceInductionBatch, sourceInductionBatchJobDigest, type SourceInductionBatchJob, type VerifiedCorpusSegmentation } from "@scce/kernel";

/** One source batch, with genuine measurement capabilities retained in this execution context only. */
export function createSourceInductionWorkerSession(job: SourceInductionBatchJob) {
  const hasher = createHasher(), { jobDigest: _digest, ...body } = job;
  if (job.jobDigest !== sourceInductionBatchJobDigest(body, hasher)) throw Error("source induction worker job identity or SHA-256 hasher differs");
  if (job.batchBudgetUtf16 !== inductionCharBudget() || job.windowCapUtf16 !== inductionDocumentCharCap()) throw Error("source induction worker window settings differ");
  const documents = job.batch.documents.filter(document => document.text.trim());
  const preparations = job.corpusIdentity ? documents.map(document => prepareCorpusSegmentationMeasurement({ documentId: document.id, text: document.text,
    sourceVersionId: document.sourceVersionId, evidenceIds: document.evidenceIds, hasher })) : [];
  let prepared: ReturnType<typeof prepareSourceInductionBatch> | undefined, induced = false, closed = false;
  return { preparations,
    verify(wire?: VerifiedCorpusSegmentation) {
      if (closed || prepared) throw Error("invalid source induction verification lifecycle");
      if (Boolean(job.corpusIdentity) !== Boolean(wire)) throw Error("source induction worker corpus mode differs");
      let verified: VerifiedCorpusSegmentation | undefined;
      if (wire) {
        const actual = wire.populationInference, expected = job.corpusIdentity!;
        if (actual.id !== expected.id || actual.featureContextId !== expected.featureContextId || actual.normalizationContractId !== expected.normalizationContractId
          || actual.sourceInventory.id !== expected.sourceInventory.id || actual.sourceInventory.count !== expected.sourceInventory.count)
          throw Error("corpus segmentation loader snapshot changed");
        const received = new Map(wire.slices.map(slice => [slice.preparation.documentId, slice]));
        if (received.size !== preparations.length || received.size !== wire.slices.length) throw Error("source induction worker context scope differs");
        verified = { populationInference: wire.populationInference, slices: preparations.map(preparation => {
          const slice = received.get(preparation.documentId);
          if (!slice || canonicalStringify(slice.preparation) !== canonicalStringify(preparation)) throw Error("source induction worker measurement descriptor changed");
          return { preparation, contextSlice: slice.contextSlice };
        }) };
      }
      prepared = prepareSourceInductionBatch({ batch: job.batch, hasher,
        ...(job.relationContextDocuments?.length ? { relationContextDocuments: job.relationContextDocuments } : {}),
        ...(verified ? { verified } : {}) });
      return { batchKey: prepared.batchKey, ...(prepared.corpusBinding ? { corpusBinding: prepared.corpusBinding } : {}) };
    },
    induce() {
      if (closed || !prepared || induced) throw Error("invalid source induction computation lifecycle");
      induced = true;
      return prepared.induce(job.retainFullModel);
    },
    close() { closed = true; prepared = undefined; preparations.length = 0; }
  };
}
