import { canonicalStringify, createHasher } from "./primitives.js";
import type { Hasher } from "./types.js";

export const NORMALIZATION_CONTRACT_SCHEMA = "scce.normalization_contract.v1" as const;

export interface NormalizationContract {
  schema: typeof NORMALIZATION_CONTRACT_SCHEMA;
  id: string;
  unicodeVersion: string;
  normalizationForm: "NFC" | "NFKC";
  caseFoldVersion: string;
  localePolicy: "locale-independent";
  graphemeAlgorithmVersion: string;
}

const CONTRACT_FIELDS = {
  schema: NORMALIZATION_CONTRACT_SCHEMA,
  unicodeVersion: "17.0.0",
  normalizationForm: "NFC" as const,
  caseFoldVersion: "scce.simple_casefold.unicode17.v1",
  localePolicy: "locale-independent" as const,
  graphemeAlgorithmVersion: "unicode_uax29_17.0.snapshot.v1"
};
const DEFAULT_CONTRACT = contractWithHasher(createHasher());
let runtimeValidated = false;

export function canonicalNormalizationContract(
  hasher: Hasher = createHasher()
): NormalizationContract {
  return contractWithHasher(hasher);
}

export function normalizeCanonicalSurface(
  exactSurface: string,
  contract: NormalizationContract = canonicalNormalizationContract()
): string {
  assertNormalizationContract(contract);
  const normalized = exactSurface.normalize(contract.normalizationForm);
  return simpleCaseFold(normalized);
}

export function assertNormalizationContract(contract: NormalizationContract): void {
  if (canonicalStringify(contract) !== canonicalStringify(DEFAULT_CONTRACT)) {
    throw new Error(`unsupported normalization contract ${contract.id}`);
  }
  assertRuntimeNormalizationBehavior();
}

export function assertRuntimeNormalizationBehavior(): void {
  if (runtimeValidated) return;
  const replay = normalizationReplayVector();
  const failures = replay.filter(row =>
    row.normalized !== simpleCaseFold(row.exact.normalize(CONTRACT_FIELDS.normalizationForm)));
  if (failures.length) {
    throw new Error(`runtime normalization behavior is incompatible with ${CONTRACT_FIELDS.unicodeVersion}`);
  }
  const graphemes = [...new Intl.Segmenter("und", { granularity: "grapheme" })
    .segment("e\u0301👩🏽‍💻🇰🇷")]
    .map(row => row.segment);
  if (canonicalStringify(graphemes) !== canonicalStringify(["e\u0301", "👩🏽‍💻", "🇰🇷"])) {
    throw new Error(`runtime grapheme behavior is incompatible with ${CONTRACT_FIELDS.graphemeAlgorithmVersion}`);
  }
  runtimeValidated = true;
}

export function normalizationReplayVector(): Array<{
  exact: string;
  normalized: string;
}> {
  return [
    { exact: "I", normalized: "i" },
    { exact: "İ", normalized: "i\u0307" },
    { exact: "ı", normalized: "ı" },
    { exact: "i", normalized: "i" },
    { exact: "Σ", normalized: "σ" },
    { exact: "ς", normalized: "σ" },
    { exact: "σ", normalized: "σ" },
    { exact: "e\u0301", normalized: "é" },
    { exact: "👩🏽‍💻", normalized: "👩🏽‍💻" },
    { exact: "العَرَبِيَّة", normalized: "العَرَبِيَّة" },
    { exact: "한글", normalized: "한글" }
  ];
}

function simpleCaseFold(value: string): string {
  return value.toLowerCase().replace(/\u03c2/gu, "\u03c3");
}

function contractWithHasher(hasher: Hasher): NormalizationContract {
  return {
    ...CONTRACT_FIELDS,
    id: `normalization_contract.${hasher.digestHex(canonicalStringify(CONTRACT_FIELDS)).slice(0, 40)}`
  };
}
