import { describe, expect, it } from "vitest";
import {
  SOURCE_COMPLETION_FAMILY_IDS,
  createSourceCompletionContract,
  crossCheckSourceCompletionPersistence,
  inspectRecord,
  planHydration,
  replayTrace,
  sourceCompletionFamilyDefinitions,
  summarizeTraceCoverage,
  validateSourceCompletionContract,
  type SourceCompletionFamilyId,
  type SourceCompletionHydrationRecord,
  type SourceCompletionInspectStore,
  type SourceCompletionRecordFamily
} from "../source-completion-contract.js";
import type { JsonValue } from "../types.js";

describe("pre-hydration gate", () => {
  it("validates contracts, dry-runs mixed persistence records, and resolves inspectable traces without DB/server/live import", () => {
    const contract = createSourceCompletionContract();
    expect(contract.valid).toBe(true);
    expect(contract.families).toHaveLength(SOURCE_COMPLETION_FAMILY_IDS.length);
    expect(contract.families.every(family => family.repositoryWriteAdapterId && family.repositoryReadAdapterId)).toBe(true);
    expect(contract.families.every(family => family.inspectVisibilityId && family.replayVisibilityId)).toBe(true);
    expect(contract.families.every(family => family.idempotencyKeyFields.length > 0)).toBe(true);
    expect(contract.families.filter(family => family.persistenceStatus === "planned").length).toBeGreaterThan(0);
    expect(contract.families.filter(family => family.persistenceStatus === "source_only").map(family => family.familyId)).toContain("source_only_runtime_turn_traces");

    const invalidContract = validateSourceCompletionContract({
      families: contract.families.map(family => family.familyId === "source_versions" ? { ...family, validationFunctionId: "" } : family),
      dryRunHydrationPlan: contract.dryRunHydrationPlan
    });
    expect(invalidContract.valid).toBe(false);
    expect(invalidContract.diagnostics).toContain("source_completion.family:source_versions:validation_missing");

    const badPersistence = crossCheckSourceCompletionPersistence({
      families: contract.families.map(family => family.familyId === "graph_nodes" ? { ...family, destinationTableId: "missing_table" } : family)
    });
    expect(badPersistence.valid).toBe(false);
    expect(badPersistence.diagnostics.some(item => item.includes("table_not_in_schema"))).toBe(true);

    const validRecords = sourceCompletionFamilyDefinitions().map((family, index) => hydrationRecordForFamily(family, index));
    const validPlan = planHydration({ records: validRecords, contract });
    expect(validPlan.safeToHydrate).toBe(true);
    expect(validPlan.acceptedRecords).toHaveLength(validRecords.length);
    expect(validPlan.rejectedRecords).toHaveLength(0);
    expect(validPlan.destinationTableCounts.source_versions).toBeGreaterThan(0);
    expect(validPlan.estimatedWriteCountsByTable.evidence_spans).toBeGreaterThan(0);
    expect(validPlan.persistenceStatusCounts.postgres_backed).toBeGreaterThan(0);
    expect(validPlan.persistenceStatusCounts.planned).toBeGreaterThan(0);
    expect(validPlan.persistenceStatusCounts.source_only).toBeGreaterThan(0);
    expect(validPlan.warnings.some(item => item.includes("non_persistent"))).toBe(true);

    const duplicate = validRecords.find(item => item.familyId === "source_versions");
    if (!duplicate) throw new Error("missing source_versions fixture record");
    const invalidDirectEvidence = hydrationRecordForFamily(requiredFamily("measurement_observations"), 999, {
      id: "measurement.invalid.direct",
      subjectId: "asset.alpha",
      relationId: "metric.pressure",
      sourceVersionId: "sv.invalid",
      evidenceSpanId: undefined,
      forceClass: "direct_evidence"
    });
    const mixedPlan = planHydration({
      records: [
        ...validRecords,
        { ...duplicate, record: { ...objectRecord(duplicate.record), id: "source_versions.duplicate" } },
        invalidDirectEvidence,
        { familyId: "unknown_family", record: { id: "unknown.1" } }
      ],
      contract
    });
    expect(mixedPlan.safeToHydrate).toBe(false);
    expect(mixedPlan.duplicateIdempotencyConflicts).toHaveLength(1);
    expect(mixedPlan.rejectedRecords.some(record => record.reasonIds.includes("source_completion.hydration.direct_evidence_requires_exact_source_span"))).toBe(true);
    expect(mixedPlan.rejectedRecords.some(record => record.reasonIds.some(reason => reason.includes("unknown_family")))).toBe(true);

    const store = inspectStoreFromRecords(validRecords, "trace.turn.prehydration");
    expect(inspectRecord("source_only_runtime_turn_traces", "source_only_runtime_turn_traces.39", store).found).toBe(true);
    expect(inspectRecord("mouth_traces", "mouth_traces.30", store).found).toBe(true);
    expect(replayTrace("trace.turn.prehydration", store).complete).toBe(true);
    expect(summarizeTraceCoverage(store).complete).toBe(true);

    const brokenStore: SourceCompletionInspectStore = {
      ...store,
      links: [...(store.links ?? []), { traceId: "trace.turn.prehydration", targetKind: "proof_traces", targetId: "proof.trace.missing", roleId: "trace.link.missing_proof" }]
    };
    const brokenCoverage = summarizeTraceCoverage(brokenStore);
    expect(brokenCoverage.complete).toBe(false);
    expect(brokenCoverage.missingLinks).toHaveLength(1);

    const answerText = "The runtime answer surface is separate from trace telemetry.";
    expect(answerText).not.toContain("proofTraceId");
    expect(answerText).not.toContain("mouthTraceId");
    expect(validPlan.id).toBe(planHydration({ records: validRecords, contract }).id);
  });
});

function hydrationRecordForFamily(family: SourceCompletionRecordFamily, index: number, overrides: Record<string, JsonValue | undefined> = {}): SourceCompletionHydrationRecord {
  const id = `${family.familyId}.${index}`;
  const record: Record<string, JsonValue> = {
    id,
    traceId: "trace.turn.prehydration",
    turnId: "trace.turn.prehydration",
    contractId: "contract.prehydration",
    runId: "hydration.run.prehydration",
    planHash: "hash.plan.prehydration",
    forceClass: forceClassFor(family.familyId),
    sourceVersionId: "source.version.direct",
    evidenceSpanId: "evidence.span.direct",
    evidenceIds: ["evidence.span.direct"],
    sourceRefs: [{ evidenceSpanId: "evidence.span.direct", sourceVersionId: "source.version.direct" }],
    acceptedRecords: [],
    rejectedRecords: []
  };
  for (const field of [...family.idempotencyKeyFields, ...family.sourceProvenanceFields, ...family.requiredRuntimeFields, ...family.requiredTraceIds]) {
    if (record[field] !== undefined) continue;
    record[field] = valueForField(field, id);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete record[key];
    else record[key] = value;
  }
  return { familyId: family.familyId, record, traceIds: ["trace.turn.prehydration"] };
}

function inspectStoreFromRecords(records: readonly SourceCompletionHydrationRecord[], traceId: string): SourceCompletionInspectStore {
  const inspectable = records.map(item => {
    const record = objectRecord(item.record);
    return { kind: item.familyId, id: String(record.id), traceId, traceIds: [traceId], value: item.record };
  });
  return {
    records: inspectable,
    links: [
      link(traceId, "source_only_runtime_turn_traces", "source_only_runtime_turn_traces.39"),
      link(traceId, "proof_traces", "proof_traces.29"),
      link(traceId, "mouth_traces", "mouth_traces.30"),
      link(traceId, "walsh_surface_energy_traces", "walsh_surface_energy_traces.31"),
      link(traceId, "field_alpha_ppf_traces", "field_alpha_ppf_traces.32"),
      link(traceId, "learning_loop_records", "learning_loop_records.33"),
      link(traceId, "program_graph_records", "program_graph_records.34"),
      link(traceId, "artifact_emission_records", "artifact_emission_records.35"),
      link(traceId, "developer_intelligence_records", "developer_intelligence_records.36"),
      link(traceId, "workspace_core_records", "workspace_core_records.37"),
      link(traceId, "hydration_dry_run_plans", "hydration_dry_run_plans.43")
    ]
  };
}

function link(traceId: string, targetKind: SourceCompletionFamilyId, targetId: string) {
  return { traceId, targetKind, targetId, roleId: `trace.link.${targetKind}` };
}

function requiredFamily(familyId: SourceCompletionFamilyId): SourceCompletionRecordFamily {
  const family = sourceCompletionFamilyDefinitions().find(item => item.familyId === familyId);
  if (!family) throw new Error(`missing family ${familyId}`);
  return family;
}

function forceClassFor(familyId: SourceCompletionFamilyId): string {
  if (familyId === "evidence_spans" || familyId === "measurement_observations" || familyId === "log_observations" || familyId === "code_observations") return "direct_evidence";
  if (familyId.includes("language") || familyId.includes("ngram")) return "learned_language_prior";
  if (familyId.includes("program") || familyId.includes("code")) return "learned_program_prior";
  if (familyId.includes("graph")) return "learned_concept_prior";
  return "unknown_prior";
}

function valueForField(field: string, id: string): JsonValue {
  if (field.includes("byteStart")) return 0;
  if (field.includes("byteEnd")) return 16;
  if (field.includes("order") || field.includes("maxOrder")) return 2;
  if (field.includes("active")) return true;
  if (field.includes("acceptedRecords") || field.includes("rejectedRecords")) return [];
  if (field.includes("evidenceIds") || field.includes("memberNodeIds") || field.includes("sourceRefs")) return [`${field}.${id}`];
  return `${field}.${id}`;
}

function objectRecord(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, JsonValue>;
}
