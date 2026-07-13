import type { IdFactory } from "./ids.js";
import type { CorrectionRuleKind, CorrectionRuleRecord } from "./storage.js";
import type { EpisodeId, EventId, EvidenceId, Hasher, JsonValue } from "./types.js";
import { clamp01, toJsonValue } from "./primitives.js";
import { detailProfileFromVector } from "./control-plane-profiles.js";

type CorrectionLanguageId = string;
type CorrectionScriptId = string;
type CorrectionSemanticFrameId = string;
export type StyleVector = number[];
export type RegisterVector = number[];
export type MeterPattern = { id?: string; vector?: number[]; units?: JsonValue };

export interface StructuredCorrectionInput {
  kind: CorrectionRuleKind;
  languageId?: CorrectionLanguageId;
  scriptId?: CorrectionScriptId;
  observedSurface?: string;
  preferredSurface?: string;
  semanticFrameId?: CorrectionSemanticFrameId;
  styleVector?: StyleVector;
  registerVector?: RegisterVector;
  meterPattern?: MeterPattern;
  evidenceRefs?: EvidenceId[];
  ownerFeedbackEventId?: EventId;
  weight?: number;
  metadata?: JsonValue;
}

export interface CorrectionRecordInput {
  episodeId: EpisodeId;
  correction: StructuredCorrectionInput;
  ownerFeedbackEventId: EventId;
  now: number;
}

export interface CorrectionMetadataInput {
  episodeId: EpisodeId;
  metadata?: JsonValue;
  ownerFeedbackEventId: EventId;
  now: number;
}

export interface CorrectionSignalInput extends CorrectionMetadataInput {
  feedbackText?: string;
}

export interface CorrectionSignalObservation {
  signalId: string;
  ruleIds: string[];
  requiresInterpretation: boolean;
  forceClass: "structured_correction" | "owner_feedback_observation";
  audit: JsonValue;
}

export interface CorrectionContext {
  requestText?: string;
  targetLanguageId?: CorrectionLanguageId;
  targetScriptId?: CorrectionScriptId;
  styleVector?: StyleVector;
  registerVector?: RegisterVector;
  meterPattern?: MeterPattern;
  surfaceKind?: "answer" | "translation" | "program" | "creative" | "report";
}

export interface SurfacePlanLike {
  targetLanguage?: CorrectionLanguageId;
  targetScript?: CorrectionScriptId;
  style?: JsonValue;
  metadata?: JsonValue;
}

export interface CorrectionMemory {
  record(input: CorrectionRecordInput): CorrectionRuleRecord;
  fromMetadata(input: CorrectionMetadataInput): CorrectionRuleRecord[];
  observeFeedback(input: CorrectionSignalInput): { rules: CorrectionRuleRecord[]; observations: CorrectionSignalObservation[] };
  retrieve(input: { rules: readonly CorrectionRuleRecord[]; context?: CorrectionContext; limit?: number }): CorrectionRuleRecord[];
  applyText(input: { text: string; rules: readonly CorrectionRuleRecord[] }): { text: string; applied: CorrectionApplication[] };
  apply<T extends SurfacePlanLike>(plan: T, rules: readonly CorrectionRuleRecord[]): T;
  styleFromRules(input: { rules: readonly CorrectionRuleRecord[]; context?: CorrectionContext }): CorrectionStyleInfluence;
  summarize(rules: readonly CorrectionRuleRecord[]): JsonValue;
}

export interface CorrectionApplication {
  ruleId: string;
  ruleKind: CorrectionRuleKind;
  pattern: string;
  replacement?: string;
  changed: boolean;
  audit: JsonValue;
}

export interface CorrectionStyleInfluence {
  detailProfileId?: string;
  tone?: string;
  styleTags: string[];
  targetLanguage?: string;
  preferredTerms: Array<{ pattern: string; replacement: string }>;
  styleVector?: StyleVector;
  registerVector?: RegisterVector;
  meterPattern?: MeterPattern;
  scriptId?: CorrectionScriptId;
  audit: JsonValue;
}

export function createCorrectionMemory(options: { idFactory: IdFactory; hasher: Hasher }): CorrectionMemory {
  return {
    record(input) {
      return ruleFromStructuredCorrection(input, options);
    },

    fromMetadata(input) {
      return structuredCorrectionsFromMetadata(input.metadata).map(correction =>
        ruleFromStructuredCorrection({ episodeId: input.episodeId, correction, ownerFeedbackEventId: input.ownerFeedbackEventId, now: input.now }, options)
      );
    },

    observeFeedback(input) {
      const rules = this.fromMetadata(input);
      const observations: CorrectionSignalObservation[] = [];
      for (const rule of rules) {
        observations.push({
          signalId: options.idFactory.semanticId("correction_signal", { episodeId: input.episodeId, ruleId: rule.id }),
          ruleIds: [rule.id],
          requiresInterpretation: false,
          forceClass: "structured_correction",
          audit: toJsonValue({
            source: "correction-memory.structured-signal",
            ruleId: rule.id,
            ruleKind: rule.ruleKind,
            ownerFeedbackEventId: input.ownerFeedbackEventId
          })
        });
      }
      const feedbackText = input.feedbackText ?? feedbackTextFromMetadata(input.metadata);
      if (feedbackText?.trim()) {
        observations.push({
          signalId: options.idFactory.semanticId("correction_signal", { episodeId: input.episodeId, ownerFeedbackEventId: input.ownerFeedbackEventId, textHash: options.hasher.digestHex(feedbackText) }),
          ruleIds: [],
          requiresInterpretation: true,
          forceClass: "owner_feedback_observation",
          audit: toJsonValue({
            source: "correction-memory.owner-feedback-observation",
            ownerFeedbackEventId: input.ownerFeedbackEventId,
            textHash: options.hasher.digestHex(feedbackText),
            textLength: feedbackText.length,
            behavioralRuleCreated: false
          })
        });
      }
      return { rules, observations };
    },

    retrieve(input) {
      const contextLanguage = input.context?.targetLanguageId;
      const contextScript = input.context?.targetScriptId;
      return input.rules
        .filter(rule => {
          const context = ruleContext(rule);
          const languageOk = !contextLanguage || !context.languageId || context.languageId === contextLanguage;
          const scriptOk = !contextScript || !context.scriptId || context.scriptId === contextScript;
          return languageOk && scriptOk;
        })
        .sort((a, b) => b.weight - a.weight || b.updatedAt - a.updatedAt)
        .slice(0, input.limit ?? 128);
    },

    applyText(input) {
      let text = input.text;
      const applied: CorrectionApplication[] = [];
      for (const rule of input.rules) {
        const before = text;
        const context = ruleContext(rule);
        if ((rule.ruleKind === "preferred_surface" || rule.ruleKind === "terminology_preference" || rule.ruleKind === "pronunciation_or_transliteration") && rule.replacement) {
          text = replaceExactSurface(text, rule.pattern, rule.replacement);
        }
        applied.push({
          ruleId: rule.id,
          ruleKind: rule.ruleKind,
          pattern: rule.pattern,
          replacement: rule.replacement,
          changed: before !== text,
          audit: toJsonValue({
            source: "correction-memory.apply-text",
            languageId: context.languageId ?? null,
            scriptId: context.scriptId ?? null,
            semanticFrameId: context.semanticFrameId ?? null,
            suppressesTerms: false
          })
        });
      }
      return { text: tidySurface(text), applied };
    },

    apply(plan, rules) {
      const influence = this.styleFromRules({ rules });
      return {
        ...plan,
        targetLanguage: influence.targetLanguage ?? plan.targetLanguage,
        targetScript: influence.scriptId ?? plan.targetScript,
        metadata: toJsonValue({ ...(isRecord(plan.metadata) ? plan.metadata : {}), correctionInfluence: influence.audit })
      };
    },

    styleFromRules(input) {
      const preferredTerms: Array<{ pattern: string; replacement: string }> = [];
      const styleTags: string[] = [];
      let targetLanguage = input.context?.targetLanguageId;
      let scriptId = input.context?.targetScriptId;
      let styleVector = input.context?.styleVector;
      let registerVector = input.context?.registerVector;
      let meterPattern = input.context?.meterPattern;
      let detailProfileId: CorrectionStyleInfluence["detailProfileId"];
      for (const rule of input.rules) {
        const context = ruleContext(rule);
        if ((rule.ruleKind === "preferred_surface" || rule.ruleKind === "terminology_preference" || rule.ruleKind === "pronunciation_or_transliteration") && rule.replacement) {
          preferredTerms.push({ pattern: rule.pattern, replacement: rule.replacement });
        }
        if (context.languageId) targetLanguage = context.languageId;
        if (context.scriptId) scriptId = context.scriptId;
        if (context.styleVector) styleVector = context.styleVector;
        if (context.registerVector) registerVector = context.registerVector;
        if (context.meterPattern) meterPattern = context.meterPattern;
        if (rule.ruleKind === "style_shift" || rule.ruleKind === "register_shift" || rule.ruleKind === "meter_constraint") styleTags.push(rule.id);
        if (rule.ruleKind === "verbosity_preference") {
          detailProfileId = detailProfileFromVector(context.styleVector ?? context.registerVector);
        }
      }
      return {
        detailProfileId,
        styleTags: [...new Set(styleTags)].slice(0, 24),
        targetLanguage,
        preferredTerms: dedupePreferredTerms(preferredTerms).slice(0, 32),
        styleVector,
        registerVector,
        meterPattern,
        scriptId,
        audit: toJsonValue({
          source: "correction-memory.structured",
          ruleCount: input.rules.length,
          ruleIds: input.rules.slice(0, 32).map(rule => rule.id),
          targetLanguage: targetLanguage ?? null,
          scriptId: scriptId ?? null,
          styleVector: styleVector ?? null,
          registerVector: registerVector ?? null,
          meterPattern: meterPattern ?? null,
          detailProfileId: detailProfileId ?? null,
          suppressesTerms: false
        })
      };
    },

    summarize(rules) {
      return toJsonValue({
        total: rules.length,
        byKind: rules.reduce<Record<string, number>>((out, rule) => {
          out[rule.ruleKind] = (out[rule.ruleKind] ?? 0) + 1;
          return out;
        }, {}),
        top: rules.slice(0, 24).map(rule => ({
          id: rule.id,
          kind: rule.ruleKind,
          scope: rule.scope,
          patternHash: options.hasher.digestHex(rule.pattern),
          replacementHash: rule.replacement ? options.hasher.digestHex(rule.replacement) : null,
          weight: rule.weight,
          updatedAt: rule.updatedAt,
          context: rule.contextJson
        }))
      });
    }
  };
}

function ruleFromStructuredCorrection(input: CorrectionRecordInput, options: { idFactory: IdFactory; hasher: Hasher }): CorrectionRuleRecord {
  const correction = input.correction;
  const pattern = correction.observedSurface ?? correction.semanticFrameId ?? correction.kind;
  const replacement = correction.preferredSurface;
  const contextJson = toJsonValue({
    languageId: correction.languageId ?? null,
    scriptId: correction.scriptId ?? null,
    semanticFrameId: correction.semanticFrameId ?? null,
    styleVector: boundedVector(correction.styleVector),
    registerVector: boundedVector(correction.registerVector),
    meterPattern: correction.meterPattern ?? null,
    evidenceRefs: correction.evidenceRefs ?? [],
    metadata: correction.metadata ?? null,
    suppressesTerms: false
  });
  const id = options.idFactory.semanticId("correction_rule", {
    kind: correction.kind,
    patternHash: options.hasher.digestHex(pattern),
    replacementHash: replacement ? options.hasher.digestHex(replacement) : null,
    contextJson
  });
  return {
    id,
    episodeId: input.episodeId,
    ruleKind: correction.kind,
    scope: correction.languageId ?? correction.scriptId ?? "global",
    pattern,
    replacement,
    weight: clamp01(correction.weight ?? 0.75),
    contextJson,
    provenanceJson: toJsonValue({
      source: "owner_structured_feedback",
      episodeId: input.episodeId,
      ownerFeedbackEventId: correction.ownerFeedbackEventId ?? input.ownerFeedbackEventId,
      recordedAt: input.now,
      mutableEvidence: false
    }),
    createdAt: input.now,
    updatedAt: input.now
  };
}

function structuredCorrectionsFromMetadata(metadata: JsonValue | undefined): StructuredCorrectionInput[] {
  if (!isRecord(metadata)) return [];
  const raw = metadata.corrections ?? metadata.correction ?? metadata.ownerCorrections;
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: StructuredCorrectionInput[] = [];
  for (const value of values) {
    const correction = structuredCorrection(value);
    if (correction) out.push(correction);
  }
  return out;
}

function feedbackTextFromMetadata(metadata: JsonValue | undefined): string | undefined {
  if (!isRecord(metadata)) return undefined;
  const candidates = [metadata.ownerFeedbackText, metadata.feedbackText, metadata.freeTextCorrection];
  for (const candidate of candidates) if (typeof candidate === "string" && candidate.trim()) return candidate;
  return undefined;
}

function structuredCorrection(value: unknown): StructuredCorrectionInput | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.kind !== "string" || !CORRECTION_KINDS.has(value.kind as CorrectionRuleKind)) return undefined;
  return {
    kind: value.kind as CorrectionRuleKind,
    languageId: typeof value.languageId === "string" ? value.languageId : undefined,
    scriptId: typeof value.scriptId === "string" ? value.scriptId : undefined,
    observedSurface: typeof value.observedSurface === "string" ? value.observedSurface : typeof value.surface === "string" ? value.surface : undefined,
    preferredSurface: typeof value.preferredSurface === "string" ? value.preferredSurface : undefined,
    semanticFrameId: typeof value.semanticFrameId === "string" ? value.semanticFrameId : undefined,
    styleVector: numericVector(value.styleVector),
    registerVector: numericVector(value.registerVector),
    meterPattern: isRecord(value.meterPattern) ? value.meterPattern as unknown as MeterPattern : undefined,
    evidenceRefs: Array.isArray(value.evidenceRefs) ? value.evidenceRefs.filter((item): item is EvidenceId => typeof item === "string") : undefined,
    ownerFeedbackEventId: typeof value.ownerFeedbackEventId === "string" ? value.ownerFeedbackEventId as EventId : undefined,
    weight: typeof value.weight === "number" ? value.weight : undefined,
    metadata: value.metadata
  };
}

function ruleContext(rule: CorrectionRuleRecord): {
  languageId?: CorrectionLanguageId;
  scriptId?: CorrectionScriptId;
  semanticFrameId?: CorrectionSemanticFrameId;
  styleVector?: StyleVector;
  registerVector?: RegisterVector;
  meterPattern?: MeterPattern;
} {
  const record = isRecord(rule.contextJson) ? rule.contextJson : {};
  return {
    languageId: typeof record.languageId === "string" ? record.languageId : undefined,
    scriptId: typeof record.scriptId === "string" ? record.scriptId : undefined,
    semanticFrameId: typeof record.semanticFrameId === "string" ? record.semanticFrameId : undefined,
    styleVector: numericVector(record.styleVector),
    registerVector: numericVector(record.registerVector),
    meterPattern: isRecord(record.meterPattern) ? record.meterPattern as unknown as MeterPattern : undefined
  };
}

function replaceExactSurface(text: string, observedSurface: string, preferredSurface: string): string {
  if (!observedSurface) return text;
  return text.split(observedSurface).join(preferredSurface);
}

function tidySurface(text: string): string {
  return text.replace(/[ \t]{2,}/gu, " ").replace(/\n{3,}/gu, "\n\n").trim();
}

function dedupePreferredTerms(input: Array<{ pattern: string; replacement: string }>): Array<{ pattern: string; replacement: string }> {
  const seen = new Set<string>();
  const out: Array<{ pattern: string; replacement: string }> = [];
  for (const item of input) {
    const key = `${item.pattern}\u001f${item.replacement}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function numericVector(value: JsonValue | undefined): number[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === "number") ? value.map(clamp01) : undefined;
}

function boundedVector(value: readonly number[] | undefined): JsonValue {
  return value ? value.map(clamp01).slice(0, 32) : null;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const CORRECTION_KINDS = new Set<CorrectionRuleKind>([
  "surface_note",
  "preferred_surface",
  "style_shift",
  "register_shift",
  "meter_constraint",
  "translation_preference",
  "terminology_preference",
  "verbosity_preference",
  "semantic_error",
  "pronunciation_or_transliteration",
  "script_preference"
]);
