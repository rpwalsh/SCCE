// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  assertBrainLifecycleTransition,
  validateBrainManifestContract,
  validationDisposition,
  type BrainLifecycleState,
  type BrainManifestContract,
  type BrainValidationCheck,
  type BrainValidationReport
} from "./brain-lifecycle.js";
import { canonicalDigestHex } from "./canonical-json-digest.js";
import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import { validateSourceCompilationModelInventory } from "./source-language-compilation.js";
import type { Hasher, JsonValue } from "./types.js";

export const WIKIPEDIA_PUBLICATION_QUALIFICATION_VALIDATOR_VERSION = "kernel.wikipedia_publication_qualification.v1" as const;
export const WIKIPEDIA_PUBLICATION_RECEIPT_SCHEMA = "scce.wikipedia_publication_receipt.v1" as const;
export const WIKIPEDIA_SOURCE_COMPILATION_INVENTORY_SCHEMA = "scce.wikipedia_source_compilation_inventory.v1" as const;

export const WIKIPEDIA_PUBLICATION_RECEIPT_KINDS = [
  "cold_reconstruction",
  "production_artifact_admission",
  "learned_realization",
  "calibration_identities",
  "http_english_evaluation"
] as const;

export type WikipediaPublicationReceiptKind = (typeof WIKIPEDIA_PUBLICATION_RECEIPT_KINDS)[number];

/** Every qualification receipt is immutable evidence for exactly this candidate. */
export interface WikipediaPublicationBinding {
  importRunId: string;
  brainVersion: string;
  manifestHash: string;
  inventoryHash: string;
  executableHash: string;
  configurationHash: string;
  policyHash: string;
  casesHash: string;
}

export interface WikipediaPublicationReceiptReference {
  kind: WikipediaPublicationReceiptKind;
  contentHash: string;
}

export interface WikipediaSourceCompilationInventoryEntry {
  receipt: JsonValue;
  models: readonly {
    id: string;
    streamId: string;
    chunk: JsonValue;
    modelDigest: string;
  }[];
}

export interface WikipediaPublicationQualificationInput {
  lifecycleState: BrainLifecycleState;
  manifest: BrainManifestContract;
  binding: WikipediaPublicationBinding;
  sourceCompilations: readonly WikipediaSourceCompilationInventoryEntry[];
  receipts: readonly WikipediaPublicationReceiptReference[];
  readContent: (contentHash: string) => Promise<Uint8Array | undefined>;
  validatedAt: number;
  hasher?: Hasher;
}

export interface WikipediaPublicationQualificationSuccess {
  qualified: true;
  report: BrainValidationReport;
  qualificationHash: string;
}

export interface WikipediaPublicationQualificationRejection {
  qualified: false;
  report: BrainValidationReport;
  rejection: {
    checkId: string;
    message: string;
  };
}

export type WikipediaPublicationQualificationResult =
  | WikipediaPublicationQualificationSuccess
  | WikipediaPublicationQualificationRejection;

/** A truthful persisted result while no independent publication evidence exists. */
export function pendingWikipediaPublicationQualification(input: {
  manifest: BrainManifestContract;
  lifecycleState: BrainLifecycleState;
  validatedAt: number;
}): WikipediaPublicationQualificationRejection {
  const checks: BrainValidationCheck[] = [
    ...validateBrainManifestContract(input.manifest),
    check(
      "publication.lifecycle.validating",
      input.lifecycleState === "VALIDATING",
      "publication qualification requires a VALIDATING candidate"
    ),
    check(
      "publication.receipts.pending",
      false,
      "independent publication receipts have not been supplied"
    )
  ];
  const report: BrainValidationReport = {
    schema: "scce.brainValidationReport.v1",
    importRunId: input.manifest.importRunId,
    brainVersion: input.manifest.brainVersion,
    manifestHash: input.manifest.manifestHash,
    validatorVersion: WIKIPEDIA_PUBLICATION_QUALIFICATION_VALIDATOR_VERSION,
    disposition: "FAILED",
    checks,
    validatedAt: input.validatedAt
  };
  return {
    qualified: false,
    report,
    rejection: {
      checkId: "publication.receipts.pending",
      message: "independent publication receipts have not been supplied"
    }
  };
}

interface PublicationReceipt {
  schema: typeof WIKIPEDIA_PUBLICATION_RECEIPT_SCHEMA;
  kind: WikipediaPublicationReceiptKind;
  binding: WikipediaPublicationBinding;
  result: Record<string, unknown>;
}

/**
 * Digest the exact, already-validated source compilation inventory that will be
 * admitted with the candidate. Callers cannot substitute a different model or
 * receipt set after qualification without invalidating every publication receipt.
 */
export function wikipediaSourceCompilationInventoryHash(
  entries: readonly WikipediaSourceCompilationInventoryEntry[],
  hasher: Hasher = createHasher()
): string {
  const material = entries.map(entry => ({ receipt: entry.receipt, models: [...entry.models] }));
  material.sort((left, right) => compareText(canonicalStringify(left), canonicalStringify(right)));
  return canonicalDigestHex({ schema: WIKIPEDIA_SOURCE_COMPILATION_INVENTORY_SCHEMA, entries: material }, hasher);
}

/**
 * Qualifies a VALIDATING Wikipedia brain for the existing VALIDATING -> READY
 * lifecycle transition. This function never changes lifecycle state or activates
 * a brain; storage remains the sole owner of those operations.
 */
export async function qualifyWikipediaPublicationCandidate(
  input: WikipediaPublicationQualificationInput
): Promise<WikipediaPublicationQualificationResult> {
  const hasher = input.hasher ?? createHasher();
  const checks: BrainValidationCheck[] = [...validateBrainManifestContract(input.manifest)];
  checks.push(check(
    "publication.lifecycle.validating",
    input.lifecycleState === "VALIDATING",
    "publication qualification requires a VALIDATING candidate"
  ));
  try {
    assertBrainLifecycleTransition("VALIDATING", "READY");
    checks.push(check("publication.lifecycle.ready_transition", true, "VALIDATING to READY is an allowed lifecycle transition"));
  } catch (error) {
    checks.push(check("publication.lifecycle.ready_transition", false, errorMessage(error)));
  }

  validateBinding(input, checks);
  validateSourceCompilations(input, hasher, checks);
  const verifiedReceipts = await verifyReceiptSet(input, hasher, checks);
  const disposition = validationDisposition(checks);
  const report: BrainValidationReport = {
    schema: "scce.brainValidationReport.v1",
    importRunId: input.binding.importRunId,
    brainVersion: input.binding.brainVersion,
    manifestHash: input.binding.manifestHash,
    validatorVersion: WIKIPEDIA_PUBLICATION_QUALIFICATION_VALIDATOR_VERSION,
    disposition,
    checks,
    validatedAt: input.validatedAt
  };
  const firstFailure = checks.find(entry => entry.severity === "error" && !entry.passed);
  if (firstFailure || disposition !== "PASSED") {
    return {
      qualified: false,
      report,
      rejection: {
        checkId: firstFailure?.id ?? "publication.qualification.failed",
        message: firstFailure?.message ?? "Wikipedia publication qualification failed"
      }
    };
  }
  const qualificationHash = canonicalDigestHex({
    schema: WIKIPEDIA_PUBLICATION_QUALIFICATION_VALIDATOR_VERSION,
    binding: input.binding,
    receipts: verifiedReceipts
      .map(receipt => ({ kind: receipt.kind, contentHash: receipt.contentHash }))
      .sort((left, right) => compareText(left.kind, right.kind))
  }, hasher);
  return { qualified: true, report, qualificationHash };
}

function validateBinding(input: WikipediaPublicationQualificationInput, checks: BrainValidationCheck[]): void {
  const { binding, manifest } = input;
  checks.push(
    check("publication.binding.import_run", binding.importRunId === manifest.importRunId, "receipt import run is bound to the manifest"),
    check("publication.binding.brain_version", binding.brainVersion === manifest.brainVersion, "receipt brain version is bound to the manifest"),
    check("publication.binding.manifest", binding.manifestHash === manifest.manifestHash, "receipt manifest hash is bound to the manifest")
  );
  for (const [name, value] of Object.entries(binding)) {
    const identity = name === "importRunId" || name === "brainVersion";
    checks.push(check(
      `publication.binding.${snakeCase(name)}_format`,
      identity ? value.length > 0 : isSha256(value),
      identity ? `${name} is present` : `${name} is a SHA-256 identity`
    ));
  }
}

function validateSourceCompilations(
  input: WikipediaPublicationQualificationInput,
  hasher: Hasher,
  checks: BrainValidationCheck[]
): void {
  if (!input.sourceCompilations.length) {
    checks.push(check("publication.source_compilations.present", false, "Wikipedia publication requires source compilation evidence"));
    return;
  }
  checks.push(check("publication.source_compilations.present", true, "source compilation evidence is present"));
  for (const [index, entry] of input.sourceCompilations.entries()) {
    try {
      validateSourceCompilationModelInventory(entry.receipt, entry.models, hasher);
      checks.push(check(`publication.source_compilations.${index}`, true, `source compilation ${index} has a complete canonical model inventory`));
    } catch (error) {
      checks.push(check(`publication.source_compilations.${index}`, false, errorMessage(error)));
    }
  }
  const actualHash = wikipediaSourceCompilationInventoryHash(input.sourceCompilations, hasher);
  checks.push(check(
    "publication.source_compilations.inventory_hash",
    actualHash === input.binding.inventoryHash,
    "source compilation inventory bytes match the publication binding",
    { expected: input.binding.inventoryHash, actual: actualHash }
  ));
}

async function verifyReceiptSet(
  input: WikipediaPublicationQualificationInput,
  hasher: Hasher,
  checks: BrainValidationCheck[]
): Promise<Array<{ kind: WikipediaPublicationReceiptKind; contentHash: string }>> {
  const references = new Map<WikipediaPublicationReceiptKind, WikipediaPublicationReceiptReference>();
  const repeatedKinds = new Set<WikipediaPublicationReceiptKind>();
  const repeatedHashes = new Set<string>();
  const seenHashes = new Set<string>();
  for (const reference of input.receipts) {
    if (references.has(reference.kind)) repeatedKinds.add(reference.kind);
    else references.set(reference.kind, reference);
    if (seenHashes.has(reference.contentHash)) repeatedHashes.add(reference.contentHash);
    seenHashes.add(reference.contentHash);
  }
  checks.push(check("publication.receipts.duplicate_kinds", repeatedKinds.size === 0,
    repeatedKinds.size ? `duplicate publication receipt kinds: ${[...repeatedKinds].join(", ")}` : "publication receipt kinds are unique"));
  checks.push(check("publication.receipts.distinct_hashes", repeatedHashes.size === 0,
    repeatedHashes.size ? "publication receipt kinds must have distinct content hashes" : "publication receipts have distinct content hashes"));

  const verified: Array<{ kind: WikipediaPublicationReceiptKind; contentHash: string }> = [];
  for (const kind of WIKIPEDIA_PUBLICATION_RECEIPT_KINDS) {
    const reference = references.get(kind);
    if (!reference) {
      checks.push(check(`publication.receipt.${kind}`, false, `missing required ${kind} publication receipt`));
      continue;
    }
    if (!isSha256(reference.contentHash)) {
      checks.push(check(`publication.receipt.${kind}`, false, `${kind} receipt has an invalid content hash`));
      continue;
    }
    let bytes: Uint8Array | undefined;
    try {
      bytes = await input.readContent(reference.contentHash);
    } catch (error) {
      checks.push(check(`publication.receipt.${kind}`, false, `${kind} receipt could not be read: ${errorMessage(error)}`));
      continue;
    }
    if (!bytes) {
      checks.push(check(`publication.receipt.${kind}`, false, `${kind} receipt bytes are missing`));
      continue;
    }
    const actualHash = hasher.digestHex(bytes);
    if (normalizeSha256(reference.contentHash) !== actualHash) {
      checks.push(check(`publication.receipt.${kind}`, false, `${kind} receipt bytes do not match their content address`, {
        expected: normalizeSha256(reference.contentHash), actual: actualHash
      }));
      continue;
    }
    try {
      const receipt = decodeReceipt(bytes);
      validateReceipt(receipt, kind, input.binding);
      checks.push(check(`publication.receipt.${kind}`, true, `${kind} receipt is content-addressed, bound, and passed`));
      verified.push({ kind, contentHash: reference.contentHash });
    } catch (error) {
      checks.push(check(`publication.receipt.${kind}`, false, errorMessage(error)));
    }
  }
  return verified;
}

function decodeReceipt(bytes: Uint8Array): PublicationReceipt {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("publication receipt is not valid UTF-8 JSON");
  }
  if (!isRecord(value) || value.schema !== WIKIPEDIA_PUBLICATION_RECEIPT_SCHEMA
    || typeof value.kind !== "string" || !isRecord(value.binding) || !isRecord(value.result)) {
    throw new Error("publication receipt has an invalid schema");
  }
  return value as unknown as PublicationReceipt;
}

function validateReceipt(
  receipt: PublicationReceipt,
  expectedKind: WikipediaPublicationReceiptKind,
  expectedBinding: WikipediaPublicationBinding
): void {
  if (receipt.kind !== expectedKind) throw new Error(`${expectedKind} receipt kind does not match its reference`);
  if (canonicalStringify(receipt.binding) !== canonicalStringify(expectedBinding)) {
    throw new Error(`${expectedKind} receipt is not bound to this candidate`);
  }
  if (receipt.result.status !== "PASSED") throw new Error(`${expectedKind} receipt did not pass`);
  switch (expectedKind) {
    case "cold_reconstruction":
      requireEqual(receipt.result.reopenedManifestHash, expectedBinding.manifestHash, "cold reconstruction manifest");
      requireEqual(receipt.result.reconstructedInventoryHash, expectedBinding.inventoryHash, "cold reconstruction inventory");
      return;
    case "production_artifact_admission":
      requireEqual(receipt.result.admittedExecutableHash, expectedBinding.executableHash, "admitted executable");
      requireEqual(receipt.result.consumedExecutableHash, expectedBinding.executableHash, "consumed executable");
      return;
    case "learned_realization":
      requireEqual(receipt.result.casesHash, expectedBinding.casesHash, "learned realization cases");
      requireAllCasesPassed(receipt.result, "learned realization");
      return;
    case "calibration_identities":
      requireEqual(receipt.result.policyHash, expectedBinding.policyHash, "calibration policy");
      if (!positiveSafeInteger(receipt.result.identityCount) || receipt.result.failedIdentityCount !== 0) {
        throw new Error("calibration identity receipt does not establish complete identity checks");
      }
      return;
    case "http_english_evaluation":
      requireEqual(receipt.result.casesHash, expectedBinding.casesHash, "HTTP evaluation cases");
      requireEqual(receipt.result.configurationHash, expectedBinding.configurationHash, "HTTP evaluation configuration");
      if (receipt.result.transport !== "http" || receipt.result.serverAdmission !== "production") {
        throw new Error("HTTP evaluation receipt did not exercise production server admission");
      }
      requireAllCasesPassed(receipt.result, "HTTP English evaluation");
  }
}

function requireAllCasesPassed(result: Record<string, unknown>, label: string): void {
  if (!positiveSafeInteger(result.totalCases) || result.passedCases !== result.totalCases) {
    throw new Error(`${label} receipt does not establish that every case passed`);
  }
}

function requireEqual(actual: unknown, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`${label} hash does not match the publication binding`);
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function check(id: string, passed: boolean, message: string, details?: unknown): BrainValidationCheck {
  return { id, passed, severity: "error", message, ...(details === undefined ? {} : { details: toJsonValue(details) }) };
}

function isSha256(value: string): boolean {
  return /^(?:sha256_)?[a-f0-9]{64}$/iu.test(value);
}

function normalizeSha256(value: string): string {
  return value.replace(/^sha256_/iu, "").toLowerCase();
}

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/gu, character => `_${character.toLowerCase()}`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
