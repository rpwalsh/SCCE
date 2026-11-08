// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher, toJsonValue, type LanguageUnitRecord, type ScceStorage, type SourceVersion } from "@scce/kernel";
import { sourceMetadataBoundOwner, unitSourceMetadataNormalizer } from "./unit-source-metadata.js";

export interface UnitMetadataMaintenanceOptions {
  batchSize?: number;
  maxBatches?: number;
  maxBatchBytes?: number;
  afterId?: string;
}

export const UNIT_METADATA_MAINTENANCE_DEFAULTS = Object.freeze({ batchSize: 128, maxBatches: 100, maxBatchBytes: 8 * 1024 * 1024 });

export interface UnitMetadataMaintenanceReport {
  schema: "scce.unit_metadata_compaction.v1";
  bounds: { batchSize: number; maxBatches: number; maxBatchBytes: number };
  batches: number;
  scanned: number;
  compacted: number;
  unchanged: number;
  oversized: number;
  missingOwners: number;
  mismatchedOwners: number;
  sourceWrites: number;
  ownerReads: number;
  decodedUnitBytes: number;
  metadataBytesBefore: number;
  metadataBytesAfter: number;
  savedMetadataBytes: number;
  lastCommittedAfterId?: string;
  complete: boolean;
}

export class UnitMetadataMaintenanceError extends Error {
  constructor(message: string, readonly report: UnitMetadataMaintenanceReport, cause: unknown) {
    super(message, { cause });
    this.name = "UnitMetadataMaintenanceError";
  }
}

function metadata(source: SourceVersion): Record<string, unknown> {
  return source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata) ? source.metadata as Record<string, unknown> : {};
}

function ownersByVersion(rows: readonly SourceVersion[]): Map<string, SourceVersion | null> {
  const owners = new Map<string, SourceVersion | null>();
  for (const row of rows) {
    const key = String(row.sourceVersionId);
    if (!owners.has(key)) owners.set(key, row);
    else if (canonicalStringify(toJsonValue(owners.get(key))) !== canonicalStringify(toJsonValue(row))) owners.set(key, null);
  }
  return owners;
}

/** Each page and its normal source/unit writes commit together; only committed cursors are returned. */
export async function compactUnitSourceMetadata(storage: ScceStorage, options: UnitMetadataMaintenanceOptions = {}): Promise<UnitMetadataMaintenanceReport> {
  const bounds = { batchSize: options.batchSize ?? UNIT_METADATA_MAINTENANCE_DEFAULTS.batchSize,
    maxBatches: options.maxBatches ?? UNIT_METADATA_MAINTENANCE_DEFAULTS.maxBatches,
    maxBatchBytes: options.maxBatchBytes ?? UNIT_METADATA_MAINTENANCE_DEFAULTS.maxBatchBytes };
  for (const [name, value] of Object.entries(bounds)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  const readPage = storage.languageMemory.listUnitSourceMetadataPage;
  if (!readPage) throw new Error("storage does not expose bounded unit metadata maintenance pages");
  const report: UnitMetadataMaintenanceReport = { schema: "scce.unit_metadata_compaction.v1", bounds, batches: 0, scanned: 0,
    compacted: 0, unchanged: 0, oversized: 0, missingOwners: 0, mismatchedOwners: 0, sourceWrites: 0, ownerReads: 0,
    decodedUnitBytes: 0, metadataBytesBefore: 0, metadataBytesAfter: 0, savedMetadataBytes: 0,
    lastCommittedAfterId: options.afterId, complete: false };
  const hasher = createHasher();
  for (let batch = 0; batch < bounds.maxBatches; batch++) {
    try {
      const result = await storage.transaction(async () => {
        const page = await readPage.call(storage.languageMemory, { afterId: report.lastCommittedAfterId, limit: bounds.batchSize, maxTotalJsonBytes: bounds.maxBatchBytes });
        if (!Number.isSafeInteger(page.decodedBytes) || page.decodedBytes < 0
          || page.units.length + page.oversized.length > bounds.batchSize || page.decodedBytes > bounds.maxBatchBytes) throw new Error("unit metadata page exceeded its declared bounds");
        if (page.hasMore && (!page.nextAfterId || page.nextAfterId === report.lastCommittedAfterId)) throw new Error("unit metadata page made no keyset progress");
        const delta = { scanned: page.units.length + page.oversized.length, compacted: 0, unchanged: 0, oversized: page.oversized.length,
          missingOwners: 0, mismatchedOwners: 0, sourceWrites: 0, ownerReads: 0, decodedUnitBytes: page.decodedBytes,
          metadataBytesBefore: 0, metadataBytesAfter: 0, savedMetadataBytes: 0 };
        const evidenceIds = [...new Set(page.units.flatMap(unit => unit.evidenceIds))];
        const initial = evidenceIds.length ? ownersByVersion(await storage.evidence.sourceVersionsForEvidence(evidenceIds)) : new Map<string, SourceVersion | null>();
        if (evidenceIds.length) delta.ownerReads++;
        const planned = new Map<string, SourceVersion>();
        const unchangedIds = new Set<string>();
        for (const unit of page.units) {
          const owner = initial.get(String(unit.sourceVersionId));
          if (!owner) continue;
          const bound = sourceMetadataBoundOwner(owner, hasher);
          const existingBinding = metadata(owner).sourceMetadataBinding;
          if (existingBinding !== undefined && canonicalStringify(toJsonValue(existingBinding)) !== canonicalStringify(toJsonValue(metadata(bound).sourceMetadataBinding))) continue;
          if (unitSourceMetadataNormalizer(bound, hasher)(unit) !== unit) planned.set(String(owner.sourceVersionId), bound);
          else {
            const row = unit.metadata && typeof unit.metadata === "object" && !Array.isArray(unit.metadata) ? unit.metadata : {};
            if (typeof row.sourceCompilationId === "string" && row.sourceCompilationId
              && canonicalStringify(toJsonValue(row.sourceMetadata)) === canonicalStringify(toJsonValue(metadata(owner).sourceMetadata))
              && canonicalStringify(toJsonValue(unit.informationLabel)) === canonicalStringify(toJsonValue(owner.informationLabel))) unchangedIds.add(unit.id);
          }
        }
        for (const owner of [...planned.values()].sort((a, b) => String(a.sourceVersionId).localeCompare(String(b.sourceVersionId)))) {
          await storage.evidence.putSourceVersion(owner);
          delta.sourceWrites++;
        }
        const verified = planned.size ? ownersByVersion(await storage.evidence.sourceVersionsForEvidence(evidenceIds)) : initial;
        if (planned.size) delta.ownerReads++;
        const normalizers = new Map<string, ReturnType<typeof unitSourceMetadataNormalizer>>();
        for (const [key, expected] of planned) {
          const actual = verified.get(key);
          if (!actual || actual.sourceId !== expected.sourceId || actual.contentHash !== expected.contentHash
            || canonicalStringify(toJsonValue(actual.informationLabel)) !== canonicalStringify(toJsonValue(expected.informationLabel))
            || canonicalStringify(toJsonValue(metadata(actual).sourceMetadata)) !== canonicalStringify(toJsonValue(metadata(expected).sourceMetadata))
            || canonicalStringify(toJsonValue(metadata(actual).sourceMetadataBinding)) !== canonicalStringify(toJsonValue(metadata(expected).sourceMetadataBinding))) continue;
          normalizers.set(key, unitSourceMetadataNormalizer(actual, hasher));
        }
        const changed: LanguageUnitRecord[] = [];
        for (const unit of page.units) {
          const before = Buffer.byteLength(canonicalStringify(unit.metadata));
          const owner = initial.get(String(unit.sourceVersionId));
          const normalized = normalizers.get(String(unit.sourceVersionId))?.(unit) ?? unit;
          const after = Buffer.byteLength(canonicalStringify(normalized.metadata));
          delta.metadataBytesBefore += before;
          delta.metadataBytesAfter += after;
          if (normalized !== unit) { changed.push(normalized); delta.compacted++; }
          else if (owner === undefined) delta.missingOwners++;
          else if (unchangedIds.has(unit.id)) delta.unchanged++;
          else delta.mismatchedOwners++;
        }
        if (changed.length) {
          if (storage.languageMemory.putLanguageUnits) await storage.languageMemory.putLanguageUnits(changed);
          else for (const unit of changed) await storage.languageMemory.putLanguageUnit(unit);
        }
        delta.savedMetadataBytes = delta.metadataBytesBefore - delta.metadataBytesAfter;
        return { delta, afterId: page.nextAfterId ?? report.lastCommittedAfterId, complete: !page.hasMore };
      });
      for (const key of Object.keys(result.delta) as Array<keyof typeof result.delta>) report[key] += result.delta[key];
      report.batches++;
      report.lastCommittedAfterId = result.afterId;
      report.complete = result.complete;
      if (report.complete) break;
    } catch (cause) {
      throw new UnitMetadataMaintenanceError("unit metadata maintenance batch rolled back", structuredClone(report), cause);
    }
  }
  return report;
}
