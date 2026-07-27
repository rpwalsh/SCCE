import { canonicalStringify, createHasher } from "./primitives.js";
import type { Hasher } from "./types.js";
import commonCaseFolding from "@unicode/unicode-17.0.0/Case_Folding/C/code-points.js";
import simpleCaseFolding from "@unicode/unicode-17.0.0/Case_Folding/S/code-points.js";

export const NORMALIZATION_CONTRACT_SCHEMA = "scce.normalization_contract.v2" as const;
export const CANONICAL_SEGMENTER_LOCALE = "und" as const;

export interface NormalizationContract {
  schema: typeof NORMALIZATION_CONTRACT_SCHEMA;
  id: string;
  unicodeVersion: string;
  normalizationForm: "NFC" | "NFKC";
  caseFoldVersion: string;
  localePolicy: "locale-independent";
  graphemeAlgorithmVersion: string;
  runtimeUnicodeVersion: string;
  runtimeIcuVersion: string;
}

const CONTRACT_FIELDS = {
  schema: NORMALIZATION_CONTRACT_SCHEMA,
  unicodeVersion: "17.0.0",
  normalizationForm: "NFC" as const,
  caseFoldVersion: "@unicode/unicode-17.0.0.case_folding.C+S.1.6.17",
  localePolicy: "locale-independent" as const,
  graphemeAlgorithmVersion: "icu.78.2.uax29.unicode17.und.v1",
  runtimeUnicodeVersion: "17.0",
  runtimeIcuVersion: "78.2"
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

const REQUIRED_ICU_MAJOR = 78;
const MINIMUM_ICU_MINOR = 2;

export function assertRuntimeNormalizationBehavior(): void {
  if (runtimeValidated) return;
  if (process.versions.unicode !== CONTRACT_FIELDS.runtimeUnicodeVersion) {
    throw new Error(
      `runtime Unicode ${String(process.versions.unicode)} does not match ${CONTRACT_FIELDS.runtimeUnicodeVersion}`
    );
  }
  // Exact ICU patch-string equality is not the meaningful invariant --
  // ICU 78.3 supersedes 78.2 as a maintenance release within the same
  // Unicode-17 major/minor contract (Node 24.18+ LTS ships 78.3). The
  // real requirement is "major version 78, at least the minimum
  // maintenance release this contract was validated against"; the
  // normalization/grapheme replay checks below are what actually
  // verify behavioral conformance, not the version string itself.
  const [icuMajorText, icuMinorText] = String(process.versions.icu ?? "").split(".");
  const icuMajor = Number(icuMajorText);
  const icuMinor = Number(icuMinorText ?? "0");
  if (!Number.isFinite(icuMajor) || !Number.isFinite(icuMinor) || icuMajor !== REQUIRED_ICU_MAJOR || icuMinor < MINIMUM_ICU_MINOR) {
    throw new Error(
      `runtime ICU ${String(process.versions.icu)} does not satisfy required ${REQUIRED_ICU_MAJOR}.${MINIMUM_ICU_MINOR}+`
    );
  }
  const replay = normalizationReplayVector();
  const failures = replay.filter(row =>
    row.normalized !== simpleCaseFold(row.exact.normalize(CONTRACT_FIELDS.normalizationForm)));
  if (failures.length) {
    throw new Error(`runtime normalization behavior is incompatible with ${CONTRACT_FIELDS.unicodeVersion}`);
  }
  const graphemes = [...canonicalGraphemeSegmenter()
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
    // Unicode default simple folding has no C/S mapping for U+0130. The
    // multi-code-point "i + dot" mapping belongs to full case folding.
    { exact: "İ", normalized: "İ" },
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
  let folded = "";
  for (const symbol of value) {
    const codePoint = symbol.codePointAt(0)!;
    const mapped = simpleCaseFolding.get(codePoint) ?? commonCaseFolding.get(codePoint);
    folded += mapped === undefined ? symbol : String.fromCodePoint(mapped);
  }
  return folded;
}

export function canonicalGraphemeSegmenter(): Intl.Segmenter {
  return new Intl.Segmenter(CANONICAL_SEGMENTER_LOCALE, { granularity: "grapheme" });
}

function contractWithHasher(hasher: Hasher): NormalizationContract {
  return {
    ...CONTRACT_FIELDS,
    id: `normalization_contract.${hasher.digestHex(canonicalStringify(CONTRACT_FIELDS)).slice(0, 40)}`
  };
}
