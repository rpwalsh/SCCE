import type { IdFactory } from "./ids.js";
import type { EvidenceSpan, Hasher, JsonValue, LanguageProfile } from "./types.js";
import type { SemanticFrameRecord, TranslationAlignmentRecord } from "./storage.js";
import { clamp01, featureSet, mean, stableVector, symbolizeData, toJsonValue, weightedJaccard } from "./primitives.js";
import {
  buildLanguageProfileClusters,
  learnedScriptIdForCharacter,
  selectLanguageProfileClusterForSurface,
  type LanguageProfileCluster
} from "./language.js";

export type TranslationForce = "direct" | "approximate" | "gloss" | "unknown";

export interface TranslationSemanticFrame {
  id: string;
  languageHint: string;
  text: string;
  symbols: string[];
  features: string[];
  roles: Array<{ id: string; shape: string; mass: number }>;
  embedding: number[];
  evidenceIds: string[];
  alpha: number;
  frameJson: JsonValue;
}

export interface TranslationFrameAlignment {
  sourceFrameId: string;
  targetFrameId?: string;
  force: TranslationForce;
  semantic: number;
  topology: number;
  scriptFit: number;
  evidenceMass: number;
  preservation: number;
  loss: TranslationLossVector;
  evidenceIds: string[];
  audit: JsonValue;
}

export interface TranslationLossVector {
  semantic: number;
  roleTopology: number;
  quantity: number;
  temporal: number;
  register: number;
  terminology: number;
  fluency: number;
  hallucination: number;
}

export interface TranslationPlan {
  id: string;
  sourceLanguage: string;
  targetLanguage: string;
  targetProfile?: LanguageProfile;
  targetCluster?: LanguageProfileCluster;
  targetSelection?: TranslationTargetSelection;
  sourceFrames: TranslationSemanticFrame[];
  targetFrames: TranslationSemanticFrame[];
  alignments: TranslationFrameAlignment[];
  force: TranslationForce;
  lossVector: TranslationLossVector;
  targetConstruct: JsonValue;
  emission: {
    text: string;
    units: Array<{ sourceFrameId: string; targetFrameId?: string; force: TranslationForce; text: string }>;
    preservation: number;
  };
  construct: TranslationConstruct;
  records: {
    semanticFrames: SemanticFrameRecord[];
    translationAlignments: TranslationAlignmentRecord[];
  };
  audit: JsonValue;
}

export interface TranslationTargetSelection {
  cluster: LanguageProfileCluster;
  profile: LanguageProfile;
  score: number;
  margin: number;
  basis: "opaque_id" | "evidence_alias" | "source_alias";
  evidenceRefs: string[];
  sourceVersionRefs: string[];
}

export interface TranslationConstruct {
  sourceLanguage: string;
  targetLanguage: string;
  force: TranslationForce;
  sourceUnits: Array<{ id: string; text: string; symbols: string[] }>;
  targetUnits: Array<{ sourceFrameId: string; targetFrameId?: string; force: TranslationForce; text: string }>;
  semanticFrames: Array<{ id: string; languageHint: string; roleShapes: string[]; evidenceIds: string[]; alpha: number }>;
  translatedText: string;
  preservedEntities: string[];
  preservedNumbers: string[];
  preservedDates: string[];
  preservedCodesymbols: string[];
  uncertainTerms: string[];
  missingAlignments: Array<{ sourceFrameId: string; text: string; reason: string }>;
  preservationValidation: TranslationPreservationValidation;
  objective: TranslationObjectiveTerms;
  evidenceRefs: Array<{ evidenceId: string; sourceVersionId: string; alpha: number }>;
  semanticPreservationScore: number;
}

export interface TranslationPreservationValidation {
  valid: boolean;
  requiredEntities: string[];
  requiredNumbers: string[];
  requiredDates: string[];
  requiredCodesymbols: string[];
  missingEntities: string[];
  missingNumbers: string[];
  missingDates: string[];
  missingCodesymbols: string[];
  blockingMissing: string[];
}

export interface TranslationObjectiveTerms {
  semanticLoss: number;
  entityLoss: number;
  relationLoss: number;
  tenseAspectMoodLoss: number;
  registerLoss: number;
  terminologyLoss: number;
  fluencyLoss: number;
  hallucinationLoss: number;
  targetNaturalness: number;
  ownerFit: number;
  energy: number;
}

export function createTranslationEngine(options: { idFactory: IdFactory; hasher: Hasher }) {
  return {
    plan(input: {
      text: string;
      targetLanguage: string;
      sourceLanguage?: string;
      evidence: EvidenceSpan[];
      profiles: LanguageProfile[];
      priorAlignments?: TranslationAlignmentRecord[];
      createdAt: number;
    }): TranslationPlan {
      const clusters = buildLanguageProfileClusters(input.profiles);
      const sourceLanguage = input.sourceLanguage ?? inferLanguageHint(input.text, clusters);
      const targetSelection = selectTargetLanguageProfileCluster(input.targetLanguage, clusters, input.evidence);
      const targetCluster = targetSelection?.cluster;
      const targetProfile = targetSelection?.profile;
      const targetLanguage = canonicalTranslationTargetKey(input.targetLanguage);
      const targetLanguageHint = targetProfile ? languageHint(targetProfile) : targetLanguage;
      const sourceFrames = framesFromText({
        text: input.text,
        languageHint: sourceLanguage,
        evidence: [],
        idPrefix: "translation_source_frame",
        idFactory: options.idFactory,
        hasher: options.hasher
      });
      const targetEvidence = input.evidence.flatMap(span => {
        const admitted = targetEvidenceAdmission(span, targetSelection, input.priorAlignments ?? [], targetLanguage);
        return admitted ? [{ span, ...admitted }] : [];
      });
      const targetFrames = targetEvidence.flatMap(({ span, owner }) => {
        return framesFromText({
          text: span.text,
          languageHint: targetLanguageHint,
          evidence: [span],
          ownership: owner,
          idPrefix: "translation_target_frame",
          idFactory: options.idFactory,
          hasher: options.hasher
        });
      });
      const alignments = sourceFrames.map(frame => alignFrame(frame, targetFrames, input.priorAlignments ?? [], targetProfile));
      const force = aggregateForce(alignments);
      const lossVector = aggregateLoss(alignments);
      const units = alignments.map(alignment => {
        const sourceFrame = sourceFrames.find(frame => frame.id === alignment.sourceFrameId)!;
        const targetFrame = alignment.targetFrameId ? targetFrames.find(frame => frame.id === alignment.targetFrameId) : undefined;
        return {
          sourceFrameId: sourceFrame.id,
          targetFrameId: targetFrame?.id,
          force: alignment.force,
          text: renderUnit(sourceFrame, targetFrame, alignment.force)
        };
      });
      const emission = {
        text: renderEmission(units, force),
        units,
        preservation: clamp01(1 - mean(Object.values(lossVector)))
      };
      const construct = buildTranslationConstruct({
        sourceLanguage,
        targetLanguage,
        force,
        sourceFrames,
        alignments,
        emission,
        targetEvidence: targetEvidence.map(row => row.span)
      });
      const semanticFrames = [...sourceFrames, ...targetFrames].map(frame => ({
        id: frame.id,
        frameJson: frame.frameJson,
        embedding: frame.embedding,
        evidenceIds: frame.evidenceIds as EvidenceSpan["id"][],
        alpha: frame.alpha,
        createdAt: input.createdAt
      } satisfies SemanticFrameRecord));
      const translationAlignments = alignments.map(alignment => ({
        id: options.idFactory.semanticId("translation_alignment", { sourceFrameId: alignment.sourceFrameId, targetFrameId: alignment.targetFrameId ?? null, force: alignment.force }),
        sourceFrameId: alignment.sourceFrameId,
        targetFrameId: alignment.targetFrameId ?? "unresolved",
        sourceLanguage,
        targetLanguage,
        force: alignment.force,
        lossVector: toJsonValue(alignment.loss),
        alignmentJson: alignment.audit,
        evidenceIds: alignment.evidenceIds as EvidenceSpan["id"][],
        updatedAt: input.createdAt
      } satisfies TranslationAlignmentRecord));
      const targetConstruct = toJsonValue({
        kind: "TranslationConstruct",
        ...construct,
        lossVector,
        frameCount: sourceFrames.length
      });
      return {
        id: options.idFactory.semanticId("translation_plan", { sourceLanguage, targetLanguage, sourceHash: options.hasher.digestHex(input.text), force, lossVector }),
        sourceLanguage,
        targetLanguage,
        ...(targetProfile ? { targetProfile } : {}),
        ...(targetCluster ? { targetCluster } : {}),
        ...(targetSelection ? { targetSelection } : {}),
        sourceFrames,
        targetFrames,
        alignments,
        force,
        lossVector,
        targetConstruct,
        emission,
        construct,
        records: { semanticFrames, translationAlignments },
        audit: toJsonValue({
          sourceLanguage,
          targetLanguage,
          targetSelection: targetSelection ? {
            clusterId: targetSelection.cluster.id,
            profileId: targetSelection.profile.id,
            score: targetSelection.score,
            margin: targetSelection.margin,
            basis: targetSelection.basis,
            evidenceRefs: targetSelection.evidenceRefs,
            sourceVersionRefs: targetSelection.sourceVersionRefs
          } : null,
          targetResolution: targetSelection ? "resolved" : "unresolved",
          force,
          construct,
          lossVector,
          sourceFrames: sourceFrames.length,
          targetFrames: targetFrames.length,
          alignments: alignments.map(item => ({ sourceFrameId: item.sourceFrameId, targetFrameId: item.targetFrameId ?? null, force: item.force, preservation: item.preservation, loss: item.loss }))
        })
      };
    }
  };
}

function framesFromText(input: {
  text: string;
  languageHint: string;
  evidence: EvidenceSpan[];
  ownership?: { profileId?: string; sourceVersionId: string };
  idPrefix: string;
  idFactory: IdFactory;
  hasher: Hasher;
}): TranslationSemanticFrame[] {
  const symbols = symbolizeData(input.text).slice(0, 4096);
  const windows = semanticWindows(symbols);
  const surfaceSymbols = sourceSurfaceSymbols(input.text).slice(0, 4096);
  const evidenceIds = input.evidence.map(span => String(span.id));
  return windows.map((window, index) => {
    const text = sourceSurfaceSlice(input.text, surfaceSymbols, window);
    const features = frameFeatures(window.symbols);
    const roles = roleTopology(window.symbols);
    const frameJson = toJsonValue({
      languageHint: input.languageHint,
      textHash: input.hasher.digestHex(text),
      symbolCount: window.symbols.length,
      shapeSignature: roles.map(role => role.shape),
      evidenceIds,
      ...(input.ownership ? {
        ...(input.ownership.profileId ? { profileId: input.ownership.profileId } : {}),
        sourceVersionId: input.ownership.sourceVersionId
      } : {})
    });
    return {
      id: input.idFactory.semanticId(input.idPrefix, {
        languageHint: input.languageHint,
        profileId: input.ownership?.profileId ?? null,
        sourceVersionId: input.ownership?.sourceVersionId ?? null,
        textHash: input.hasher.digestHex(text),
        index,
        evidenceIds
      }),
      languageHint: input.languageHint,
      text,
      symbols: window.symbols,
      features,
      roles,
      embedding: stableVector(features, input.hasher, 64),
      evidenceIds,
      alpha: input.evidence.length ? mean(input.evidence.map(span => span.alpha)) : 0.4,
      frameJson
    };
  });
}

interface SemanticWindow {
  symbols: string[];
  symbolStart: number;
  surfaceEnd: number;
}

interface SourceSurfaceSymbol {
  canonical: string;
  start: number;
  end: number;
}

function sourceSurfaceSymbols(text: string): SourceSurfaceSymbol[] {
  const safe = text.replace(/\u0000/gu, " ");
  const out: SourceSurfaceSymbol[] = [];
  const pattern = /[\p{Letter}\p{Mark}\p{Number}_]+|[^\s]/gu;
  for (const match of safe.matchAll(pattern)) {
    const start = match.index;
    if (start === undefined) continue;
    out.push({
      canonical: match[0].normalize("NFC").toLowerCase(),
      start,
      end: start + match[0].length
    });
  }
  return out;
}

function sourceSurfaceSlice(text: string, surfaceSymbols: readonly SourceSurfaceSymbol[], window: SemanticWindow): string {
  const safe = text.replace(/\u0000/gu, " ");
  const start = surfaceSymbols[window.symbolStart]?.start;
  const end = surfaceSymbols[window.surfaceEnd - 1]?.end;
  const aligned = window.symbols.every((symbol, offset) => surfaceSymbols[window.symbolStart + offset]?.canonical === symbol);
  if (start !== undefined && end !== undefined && aligned) return safe.slice(start, end).trim();

  // Normalization can alter token boundaries for unusual combining-mark
  // sequences. Keep a literal source slice instead of realizing normalized
  // semantic symbols as generated, lower-cased text.
  return safe.slice(start ?? 0, end ?? safe.length).trim();
}

function alignFrame(source: TranslationSemanticFrame, targets: TranslationSemanticFrame[], priors: TranslationAlignmentRecord[], targetProfile: LanguageProfile | undefined): TranslationFrameAlignment {
  let best: TranslationFrameAlignment | undefined;
  for (const target of targets) {
    const semantic = clamp01((cosine01(source.embedding, target.embedding) + weightedJaccard(source.features, target.features)) / 2);
    const topology = roleTopologyFit(source.roles, target.roles);
    const scriptFit = targetProfile ? profileFit(target, targetProfile) : 0.35;
    const evidenceMass = target.alpha;
    const priorBoost = priorAlignmentBoost(source.id, target.id, priors);
    const preservation = clamp01(0.34 * semantic + 0.24 * topology + 0.22 * scriptFit + 0.14 * evidenceMass + 0.06 * priorBoost);
    const force = forceFromPreservation(preservation, target.evidenceIds.length, priorBoost);
    const loss = {
      semantic: clamp01(1 - semantic),
      roleTopology: clamp01(1 - topology),
      quantity: quantityLoss(source.symbols, target.symbols),
      temporal: temporalLoss(source.symbols, target.symbols),
      register: clamp01(1 - scriptFit),
      terminology: clamp01(1 - weightedJaccard(source.features.filter(f => f.startsWith("sym:")), target.features.filter(f => f.startsWith("sym:")))),
      fluency: clamp01(1 - target.alpha),
      hallucination: hallucinationLoss(source, target)
    };
    const candidate = {
      sourceFrameId: source.id,
      targetFrameId: target.id,
      force,
      semantic,
      topology,
      scriptFit,
      evidenceMass,
      preservation,
      loss,
      evidenceIds: [...new Set([...source.evidenceIds, ...target.evidenceIds])],
      audit: toJsonValue({ semantic, topology, scriptFit, evidenceMass, priorBoost, preservation, loss })
    };
    if (!best || candidate.preservation > best.preservation) best = candidate;
  }
  if (best) return best;
  const loss = { semantic: 1, roleTopology: 1, quantity: 0.5, temporal: 0.5, register: 1, terminology: 1, fluency: 1, hallucination: 0 };
  return {
    sourceFrameId: source.id,
    force: "gloss",
    semantic: 0,
    topology: 0,
    scriptFit: 0,
    evidenceMass: 0,
    preservation: 0,
    loss,
    evidenceIds: source.evidenceIds,
    audit: toJsonValue({ unresolved: true, loss })
  };
}

function semanticWindows(symbols: string[]): SemanticWindow[] {
  if (!symbols.length) return [];
  const out: SemanticWindow[] = [];
  let current: string[] = [];
  let symbolStart = 0;
  for (let index = 0; index < symbols.length; index++) {
    const symbol = symbols[index]!;
    if (/^[\p{Punctuation}\p{Symbol}]$/u.test(symbol) && current.length) {
      out.push({ symbols: current, symbolStart, surfaceEnd: index + 1 });
      current = [];
      continue;
    }
    if (!current.length) symbolStart = index;
    current.push(symbol);
    if (current.length >= 18) {
      out.push({ symbols: current, symbolStart, surfaceEnd: index + 1 });
      current = [];
    }
  }
  if (current.length) out.push({ symbols: current, symbolStart, surfaceEnd: symbols.length });
  return out.slice(0, 256);
}

function frameFeatures(symbols: readonly string[]): string[] {
  const text = symbols.join(" ");
  const base = featureSet(text, 256);
  const shapes = roleTopology(symbols).map(role => `role:${role.shape}`);
  const quantities = symbols.filter(symbol => /\p{Number}/u.test(symbol)).map(symbol => `q:${symbol.replace(/\p{Number}/gu, "N")}`);
  return [...new Set([...base, ...shapes, ...quantities])].slice(0, 384);
}

function roleTopology(symbols: readonly string[]): Array<{ id: string; shape: string; mass: number }> {
  const total = Math.max(1, symbols.length);
  return symbols.map((symbol, index) => ({ id: String(index), shape: shapeOf(symbol), mass: 1 / total }));
}

function roleTopologyFit(left: readonly { shape: string; mass: number }[], right: readonly { shape: string; mass: number }[]): number {
  const n = Math.max(left.length, right.length);
  if (n === 0) return 1;
  let matched = 0;
  for (let i = 0; i < n; i++) {
    const a = left[i];
    const b = right[i];
    if (!a || !b) continue;
    matched += a.shape === b.shape ? Math.min(a.mass, b.mass) : shapeSimilarity(a.shape, b.shape) * Math.min(a.mass, b.mass);
  }
  return clamp01(matched * Math.max(left.length, right.length));
}

function profileFit(frame: TranslationSemanticFrame, profile: LanguageProfile): number {
  const script = profile.scripts.slice().sort((a, b) => b.mass - a.mass)[0]?.script ?? "unknown";
  const scriptMass = frame.languageHint.includes(script) ? 1 : 0.2;
  const profileFeatures = [
    ...profile.charNgrams.slice(0, 128).map(item => `char:${item.ngram}`),
    ...profile.symbolShapes.slice(0, 64).map(item => `shape:${item.shape}`)
  ];
  return clamp01(0.45 * scriptMass + 0.55 * weightedJaccard(frame.features, profileFeatures));
}

export function selectTargetLanguageProfileCluster(
  targetLanguage: string,
  clusters: readonly LanguageProfileCluster[],
  evidence: readonly EvidenceSpan[] = []
): TranslationTargetSelection | undefined {
  const opaqueTarget = targetLanguage.normalize("NFC").trim();
  const nameTarget = opaqueTarget.toLowerCase();
  if (!opaqueTarget) return undefined;
  const evidenceById = new Map(evidence.map(span => [String(span.id), span]));
  const candidates = new Map<string, Omit<TranslationTargetSelection, "margin">>();
  for (const cluster of clusters) {
    const orderedMembers = [...cluster.members].sort((left, right) => compareCodePoint(left.id, right.id));
    const exactProfile = orderedMembers.find(profile => profile.id === opaqueTarget);
    if (cluster.id === opaqueTarget || exactProfile) {
      return {
        cluster,
        profile: exactProfile ?? orderedMembers[0]!,
        score: 1,
        margin: 1,
        basis: "opaque_id",
        evidenceRefs: [],
        sourceVersionRefs: []
      };
    }
    const names = cluster.discoveredNames
      .filter(name => name.surface.normalize("NFC").trim().toLowerCase() === nameTarget && name.confidence > 0)
      .sort((left, right) => right.confidence - left.confidence || compareCodePoint(left.surface, right.surface));
    for (const name of names) {
      for (const owner of name.owners) {
        const profile = orderedMembers.find(member => member.id === owner.profileId && member.sourceVersionId === owner.sourceVersionId);
        if (!profile) continue;
        const verifiedEvidenceRefs = owner.evidenceRefs.filter(ref => {
          const span = evidenceById.get(ref);
          return span?.sourceVersionId === owner.sourceVersionId;
        }).sort(compareCodePoint);
        const verifiedSourceVersionRefs = owner.sourceVersionRefs
          .filter(ref => ref === owner.sourceVersionId)
          .map(String)
          .sort(compareCodePoint);
        if (!verifiedEvidenceRefs.length && !verifiedSourceVersionRefs.length) continue;
        const candidate: Omit<TranslationTargetSelection, "margin"> = {
          cluster,
          profile,
          score: clamp01(owner.confidence),
          basis: verifiedEvidenceRefs.length ? "evidence_alias" : "source_alias",
          evidenceRefs: verifiedEvidenceRefs,
          sourceVersionRefs: verifiedSourceVersionRefs
        };
        const existing = candidates.get(cluster.id);
        if (!existing || candidate.score > existing.score
          || candidate.score === existing.score && compareCodePoint(candidate.profile.id, existing.profile.id) < 0) {
          candidates.set(cluster.id, candidate);
        }
      }
    }
  }
  const ranked = [...candidates.values()]
    .sort((left, right) => right.score - left.score || compareCodePoint(left.cluster.id, right.cluster.id));
  const selected = ranked[0];
  if (!selected || selected.score <= 0) return undefined;
  const margin = selected.score - (ranked[1]?.score ?? 0);
  if (margin < 0.12) return undefined;
  return { ...selected, margin };
}

export function canonicalTranslationTargetKey(targetLanguage: string): string {
  return targetLanguage.normalize("NFC").trim().toLowerCase();
}

function targetEvidenceAdmission(
  span: EvidenceSpan,
  selection: TranslationTargetSelection | undefined,
  priors: readonly TranslationAlignmentRecord[],
  targetKey: string
): { owner: { profileId?: string; sourceVersionId: string }; basis: "profile_source" | "evidence_language_hint" | "verified_alignment" } | undefined {
  if (span.status !== "promoted") return undefined;
  const directOwner = selection?.cluster.members.find(member => member.sourceVersionId === span.sourceVersionId);
  if (directOwner) return {
    owner: { profileId: directOwner.id, sourceVersionId: String(span.sourceVersionId) },
    basis: "profile_source"
  };
  const languageHints = span.languageHints !== null && typeof span.languageHints === "object" && !Array.isArray(span.languageHints)
    ? span.languageHints
    : {};
  const evidenceLanguage = typeof languageHints.language === "string" ? languageHints.language.trim() : "";
  if (evidenceLanguage && canonicalTranslationTargetKey(evidenceLanguage) === targetKey) {
    return {
      owner: { sourceVersionId: String(span.sourceVersionId) },
      basis: "evidence_language_hint"
    };
  }
  const aligned = priors.some(prior => canonicalTranslationTargetKey(prior.targetLanguage) === targetKey
    && (prior.force === "direct" || prior.force === "approximate")
    && prior.evidenceIds.some(evidenceId => String(evidenceId) === String(span.id)));
  return aligned ? {
    owner: { sourceVersionId: String(span.sourceVersionId) },
    basis: "verified_alignment"
  } : undefined;
}

function inferLanguageHint(text: string, clusters: readonly LanguageProfileCluster[]): string {
  const selected = selectLanguageProfileClusterForSurface(clusters, text);
  const profile = selected?.cluster.members.slice().sort((left, right) => compareCodePoint(left.id, right.id))[0];
  return profile ? languageHint(profile) : `script:${scriptHint(text)};direction:unknown`;
}

function languageHint(profile: LanguageProfile): string {
  const script = profile.scripts.slice().sort((a, b) => b.mass - a.mass)[0]?.script ?? "unknown";
  return `profile:${profile.id};script:${script};direction:${profile.direction}`;
}

function priorAlignmentBoost(sourceFrameId: string, targetFrameId: string, priors: readonly TranslationAlignmentRecord[]): number {
  const exact = priors.find(item => item.sourceFrameId === sourceFrameId && item.targetFrameId === targetFrameId);
  if (!exact) return 0;
  const loss = exact.lossVector as Partial<TranslationLossVector>;
  const meanLoss = mean(Object.values(loss).filter((value): value is number => typeof value === "number"));
  return clamp01(1 - meanLoss);
}

function forceFromPreservation(preservation: number, evidenceCount: number, priorBoost: number): TranslationForce {
  if (preservation >= 0.74 && evidenceCount > 0) return "direct";
  if (preservation >= 0.48 || priorBoost >= 0.5) return "approximate";
  if (preservation >= 0.16) return "gloss";
  return "unknown";
}

function aggregateForce(alignments: readonly TranslationFrameAlignment[]): TranslationForce {
  if (!alignments.length) return "unknown";
  const preservation = mean(alignments.map(item => item.preservation));
  const direct = alignments.filter(item => item.force === "direct").length / alignments.length;
  if (direct >= 0.7 && preservation >= 0.72) return "direct";
  if (preservation >= 0.46) return "approximate";
  if (preservation >= 0.12) return "gloss";
  return "unknown";
}

function aggregateLoss(alignments: readonly TranslationFrameAlignment[]): TranslationLossVector {
  const keys: Array<keyof TranslationLossVector> = ["semantic", "roleTopology", "quantity", "temporal", "register", "terminology", "fluency", "hallucination"];
  const out = {} as TranslationLossVector;
  for (const key of keys) out[key] = clamp01(mean(alignments.map(item => item.loss[key])));
  return out;
}

function renderUnit(source: TranslationSemanticFrame, target: TranslationSemanticFrame | undefined, force: TranslationForce): string {
  if (target && (force === "direct" || force === "approximate")) return target.text;
  if (target && force === "gloss") return `${target.text} [${source.text}]`;
  if (force === "gloss") return `[${source.text}]`;
  return "";
}

function renderEmission(units: readonly { text: string }[], force: TranslationForce): string {
  const text = units.map(unit => unit.text).join(" ").replace(/\s+([,.;:!?])/gu, "$1").trim();
  return force === "unknown" ? "" : text;
}

function buildTranslationConstruct(input: {
  sourceLanguage: string;
  targetLanguage: string;
  force: TranslationForce;
  sourceFrames: TranslationSemanticFrame[];
  alignments: TranslationFrameAlignment[];
  emission: TranslationPlan["emission"];
  targetEvidence: EvidenceSpan[];
}): TranslationConstruct {
  const sourceText = input.sourceFrames.map(frame => frame.text).join(" ");
  const translatedText = input.force === "unknown" ? "" : input.emission.text;
  const preservationValidation = validatePreservation(sourceText, translatedText);
  const objective = translationObjective(input.alignments, preservationValidation);
  const missingAlignments = input.alignments
    .filter(alignment => !alignment.targetFrameId || alignment.force === "unknown")
    .map(alignment => {
      const source = input.sourceFrames.find(frame => frame.id === alignment.sourceFrameId);
      return {
        sourceFrameId: alignment.sourceFrameId,
        text: source?.text ?? "",
        reason: alignment.targetFrameId ? "alignment-force-unknown" : "no-target-frame"
      };
    });
  const uncertainTerms = input.alignments
    .filter(alignment => alignment.force === "gloss" || alignment.force === "unknown" || alignment.preservation < 0.48)
    .flatMap(alignment => input.sourceFrames.find(frame => frame.id === alignment.sourceFrameId)?.symbols ?? [])
    .filter(symbol => symbol.length > 1)
    .slice(0, 64);
  return {
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    force: input.force,
    sourceUnits: input.sourceFrames.map(frame => ({ id: frame.id, text: frame.text, symbols: frame.symbols })),
    targetUnits: input.emission.units,
    semanticFrames: input.sourceFrames.map(frame => ({
      id: frame.id,
      languageHint: frame.languageHint,
      roleShapes: frame.roles.map(role => role.shape).slice(0, 32),
      evidenceIds: frame.evidenceIds,
      alpha: frame.alpha
    })),
    translatedText,
    preservedEntities: preservationValidation.requiredEntities.filter(term => !preservationValidation.missingEntities.includes(term)),
    preservedNumbers: preservationValidation.requiredNumbers.filter(term => !preservationValidation.missingNumbers.includes(term)),
    preservedDates: preservationValidation.requiredDates.filter(term => !preservationValidation.missingDates.includes(term)),
    preservedCodesymbols: preservationValidation.requiredCodesymbols.filter(term => !preservationValidation.missingCodesymbols.includes(term)),
    uncertainTerms: [...new Set([...uncertainTerms, ...preservationValidation.blockingMissing])],
    missingAlignments,
    preservationValidation,
    objective,
    evidenceRefs: input.targetEvidence.slice(0, 16).map(span => ({ evidenceId: String(span.id), sourceVersionId: String(span.sourceVersionId), alpha: span.alpha })),
    semanticPreservationScore: clamp01(0.55 * input.emission.preservation + 0.45 * (1 - objective.energy))
  };
}

function preservedTerms(text: string): string[] {
  const terms = text.match(/(?:[A-Z][\p{Letter}\p{Number}_-]{1,}(?:\s+[A-Z][\p{Letter}\p{Number}_-]{1,}){0,4}|\p{Sc}?\d+(?:[.,:/_-]\d+)*(?:[%‰])?|[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$.]*|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+)/gu) ?? [];
  return [...new Set(terms)].slice(0, 80);
}

function validatePreservation(sourceText: string, translatedText: string): TranslationPreservationValidation {
  const terms = protectedTermClasses(sourceText);
  const target = normalizeForPreservation(translatedText);
  const missingEntities = terms.entities.filter(term => !target.includes(normalizeForPreservation(term)));
  const missingNumbers = terms.numbers.filter(term => !target.includes(normalizeForPreservation(term)));
  const missingDates = terms.dates.filter(term => !target.includes(normalizeForPreservation(term)));
  const missingCodesymbols = terms.codesymbols.filter(term => !target.includes(normalizeForPreservation(term)));
  const blockingMissing = [...missingNumbers, ...missingDates, ...missingCodesymbols];
  return {
    valid: blockingMissing.length === 0,
    requiredEntities: terms.entities,
    requiredNumbers: terms.numbers,
    requiredDates: terms.dates,
    requiredCodesymbols: terms.codesymbols,
    missingEntities,
    missingNumbers,
    missingDates,
    missingCodesymbols,
    blockingMissing
  };
}

function translationObjective(alignments: readonly TranslationFrameAlignment[], preservation: TranslationPreservationValidation): TranslationObjectiveTerms {
  const loss = aggregateLoss(alignments);
  const requiredEntities = Math.max(1, preservation.requiredEntities.length);
  const entityLoss = clamp01(preservation.missingEntities.length / requiredEntities);
  const targetNaturalness = clamp01(mean(alignments.map(item => item.force === "direct" ? 0.8 : item.force === "approximate" ? 0.62 : item.force === "gloss" ? 0.28 : 0)));
  const ownerFit = preservation.blockingMissing.length ? 0.2 : 0.65;
  const terms = {
    semanticLoss: loss.semantic,
    entityLoss,
    relationLoss: loss.roleTopology,
    tenseAspectMoodLoss: loss.temporal,
    registerLoss: loss.register,
    terminologyLoss: loss.terminology,
    fluencyLoss: loss.fluency,
    hallucinationLoss: loss.hallucination,
    targetNaturalness,
    ownerFit,
    energy: 0
  };
  terms.energy = clamp01(
    0.18 * terms.semanticLoss +
    0.12 * terms.entityLoss +
    0.12 * terms.relationLoss +
    0.1 * terms.tenseAspectMoodLoss +
    0.1 * terms.registerLoss +
    0.13 * terms.terminologyLoss +
    0.11 * terms.fluencyLoss +
    0.1 * terms.hallucinationLoss -
    0.08 * terms.targetNaturalness -
    0.06 * terms.ownerFit +
    (preservation.blockingMissing.length ? 0.18 : 0)
  );
  return terms;
}

function protectedTermClasses(text: string): { entities: string[]; numbers: string[]; dates: string[]; codesymbols: string[] } {
  const numbers = text.match(/\p{Sc}?[+-]?\d+(?:[.,:/_-]\d+)*(?:[%‰])?/gu) ?? [];
  const dates = text.match(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}:\d{2}(?::\d{2})?/gu) ?? [];
  const codesymbols = text.match(/[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$.]*|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+|[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sql|py|rs|cs|java|go|cpp|h|hpp|yml|yaml)/gu) ?? [];
  const entities = text.match(/[A-Z][\p{Letter}\p{Number}_-]{1,}(?:\s+[A-Z][\p{Letter}\p{Number}_-]{1,}){0,4}|[A-Z]{2,}[\p{Letter}\p{Number}_-]*/gu) ?? [];
  const numberSet = new Set<string>(numbers as string[]);
  const dateSet = new Set<string>(dates as string[]);
  const codesymbolSet = new Set<string>(codesymbols as string[]);
  return {
    entities: unique(entities.filter(term => !numberSet.has(term) && !dateSet.has(term) && !codesymbolSet.has(term))).slice(0, 80),
    numbers: unique(numbers).slice(0, 80),
    dates: unique(dates).slice(0, 80),
    codesymbols: unique(codesymbols).slice(0, 80)
  };
}

function normalizeForPreservation(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function quantityLoss(left: readonly string[], right: readonly string[]): number {
  const a = left.filter(symbol => /\p{Number}/u.test(symbol)).map(symbol => symbol.replace(/\p{Number}/gu, "N"));
  const b = right.filter(symbol => /\p{Number}/u.test(symbol)).map(symbol => symbol.replace(/\p{Number}/gu, "N"));
  return clamp01(1 - weightedJaccard(a, b));
}

function temporalLoss(left: readonly string[], right: readonly string[]): number {
  const pattern = /(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}:\d{2}(?::\d{2})?)/u;
  const a = left.filter(symbol => pattern.test(symbol)).map(symbol => symbol.replace(/\p{Number}/gu, "N"));
  const b = right.filter(symbol => pattern.test(symbol)).map(symbol => symbol.replace(/\p{Number}/gu, "N"));
  if (!a.length && !b.length) return 0;
  return clamp01(1 - weightedJaccard(a, b));
}

function hallucinationLoss(source: TranslationSemanticFrame, target: TranslationSemanticFrame): number {
  const sourceMass = new Set(source.roles.map(role => role.shape));
  const extra = target.roles.filter(role => !sourceMass.has(role.shape)).length;
  return clamp01(extra / Math.max(1, target.roles.length));
}

function cosine01(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa > 0 && bb > 0 ? clamp01((dot / Math.sqrt(aa * bb) + 1) / 2) : 0;
}

function shapeSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const n = Math.max(left.length, right.length);
  if (!n) return 1;
  let same = 0;
  for (let i = 0; i < n; i++) if (left[i] === right[i]) same++;
  return same / n;
}

function shapeOf(text: string): string {
  return [...text].map(char => /\p{Letter}/u.test(char) ? "L" : /\p{Number}/u.test(char) ? "N" : /\p{Punctuation}/u.test(char) ? "P" : /\p{Symbol}/u.test(char) ? "S" : "O").join("");
}

function scriptHint(text: string): string {
  const chars = [...text].filter(char => !/\s/u.test(char));
  const counts = new Map<string, number>();
  for (const char of chars) {
    const script = learnedScriptIdForCharacter(char);
    counts.set(script, (counts.get(script) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || compareCodePoint(left[0], right[0]))[0]?.[0] ?? "script:Zxxx";
}

function compareCodePoint(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const x = a[index]!.codePointAt(0)!;
    const y = b[index]!.codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}
