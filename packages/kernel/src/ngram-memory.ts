import type { IdFactory } from "./ids.js";
import type {
  EvidenceSpan,
  Hasher,
  JsonValue,
  LanguageProfile,
  SourceVersionId
} from "./types.js";
import type {
  LanguagePatternRecord,
  LanguageUnitRecord,
  NgramModelRecord,
  NgramObservation,
  SemanticFrameRecord
} from "./storage.js";
import { learnedScriptIdForCharacter } from "./language.js";
import { compactKneserNeyForProfile, trainKneserNey } from "./kneser-ney.js";
import { clamp01, entropy, featureSet, stableVector, symbolizeData, toJsonValue } from "./primitives.js";

export interface NgramMemoryCompilation {
  observations: NgramObservation[];
  models: NgramModelRecord[];
  units: LanguageUnitRecord[];
  patterns: LanguagePatternRecord[];
  semanticFrames: SemanticFrameRecord[];
  audit: JsonValue;
}

export interface NgramMemoryInput {
  streamId: string;
  profile: LanguageProfile;
  sourceVersionId: SourceVersionId;
  text: string;
  evidence: EvidenceSpan[];
  createdAt: number;
  maxOrder?: number;
  maxCountersPerOrder?: number;
  vocabularyLimit?: number;
}

export function createNgramMemoryCompiler(options: { idFactory: IdFactory; hasher: Hasher }) {
  return {
    compile(input: NgramMemoryInput): NgramMemoryCompilation {
      const maxOrder = Math.max(1, Math.min(6, input.maxOrder ?? 6));
      const maxCounters = Math.max(32, input.maxCountersPerOrder ?? 50000);
      const symbols = symbolizeData(input.text);
      const languageHint = primaryLanguageHint(input.profile);
      const evidenceIds = input.evidence.map(span => span.id);
      const alpha = input.evidence.length ? input.evidence.reduce((sum, span) => sum + span.alpha, 0) / input.evidence.length : 0.35;
      const counters = Array.from({ length: maxOrder }, (_, i) => new SpaceSavingCounter<string>(maxCounters, i + 1));
      for (let i = 0; i < symbols.length; i++) {
        for (let order = 1; order <= maxOrder; order++) {
          if (i + 1 < order) continue;
          const gram = symbols.slice(i + 1 - order, i + 1).join("\u0001");
          counters[order - 1]!.offer(gram);
        }
      }
      const observations = counters.flatMap(counter => {
        const total = Math.max(1, counter.total);
        return counter.entries().map(entry => {
          const parts = entry.key.split("\u0001");
          const symbol = parts[parts.length - 1] ?? "";
          const history = parts.slice(0, -1);
          const fieldWeight = clamp01((entry.count / total) * (0.35 + 0.65 * alpha));
          return {
            id: options.idFactory.semanticId("ngram_observation", { streamId: input.streamId, profileId: input.profile.id, languageHint, order: counter.order, parts, sourceVersionId: input.sourceVersionId }),
            streamId: input.streamId,
            languageHint,
            order: counter.order,
            history,
            symbol,
            count: entry.count,
            fieldWeight,
            sourceVersionId: input.sourceVersionId,
            evidenceId: evidenceIds[0],
            observedAt: input.createdAt,
            metadata: toJsonValue({ profileId: input.profile.id, error: entry.error, approximate: entry.error > 0, evidenceIds: evidenceIds.slice(0, 16) })
          } satisfies NgramObservation;
        });
      });
      const kneserNeyModels = [trainKneserNey(symbols, { order: maxOrder, discount: 0.75, vocabularyLimit: input.vocabularyLimit ?? 24000 })];
      const models = kneserNeyModels.map(model => ({
        id: options.idFactory.semanticId("ngram_model", { streamId: input.streamId, profileId: input.profile.id, languageHint, order: model.order, sourceVersionId: input.sourceVersionId }),
        streamId: input.streamId,
        languageHint,
        maxOrder: model.order,
        discount: model.discount,
        modelJson: toJsonValue({
          sourceVersionId: input.sourceVersionId,
          profileId: input.profile.id,
          languageHint,
          model,
          compact: compactKneserNeyForProfile(model, input.text)
        }),
        updatedAt: input.createdAt
      } satisfies NgramModelRecord));
      const units = compileLanguageUnits({ profile: input.profile, sourceVersionId: input.sourceVersionId, symbols, evidenceIds, alpha, idFactory: options.idFactory, hasher: options.hasher });
      const patterns = compileLanguagePatterns({ profile: input.profile, sourceVersionId: input.sourceVersionId, symbols, evidence: input.evidence, evidenceIds, createdAt: input.createdAt, idFactory: options.idFactory });
      const semanticFrames = input.evidence.slice(0, 512).map((span, index) => semanticFrameForSpan(
        span,
        index,
        input.profile.id,
        options.idFactory,
        options.hasher,
        input.createdAt
      ));
      return {
        observations,
        models,
        units,
        patterns,
        semanticFrames,
        audit: toJsonValue({
          streamId: input.streamId,
          sourceVersionId: input.sourceVersionId,
          languageHint,
          symbolCount: symbols.length,
          orders: counters.map(counter => ({ order: counter.order, retained: counter.size, total: counter.total })),
          observations: observations.length,
          models: models.length,
          modelOrders: models.map(model => model.maxOrder),
          units: units.length,
          patterns: patterns.length,
          semanticFrames: semanticFrames.length
        })
      };
    }
  };
}

function compileLanguageUnits(input: {
  profile: LanguageProfile;
  sourceVersionId: SourceVersionId;
  symbols: string[];
  evidenceIds: EvidenceSpan["id"][];
  alpha: number;
  idFactory: IdFactory;
  hasher: Hasher;
}): LanguageUnitRecord[] {
  const symbolCounts = count(input.symbols);
  const symbolUnits = [...symbolCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 96).map(([text, c]) => {
    const features = featureSet(text, 64);
    return unit(input, "symbol", text, features, clamp01(input.alpha * Math.log2(c + 1) / 8));
  });
  const graphemeCounts = count([...input.symbols.join("")]);
  const graphemeUnits = [...graphemeCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 32).map(([text, c]) => {
    const features = [`grapheme:${text}`, `shape:${shapeOf(text)}`];
    return unit(input, "grapheme", text, features, clamp01(input.alpha * Math.log2(c + 1) / 8));
  });
  const phraseUnits = phraseCandidates(input.symbols).slice(0, 48).map(phrase => unit(input, "phrase", phrase.text, featureSet(phrase.text, 96), clamp01(input.alpha * phrase.score)));
  const syntaxUnits = syntaxSignatures(input.symbols).slice(0, 24).map(signature => unit(input, "syntax_pattern", signature.text, [`syntax:${signature.text}`], clamp01(input.alpha * signature.score)));
  return [...symbolUnits, ...graphemeUnits, ...phraseUnits, ...syntaxUnits];
}

function unit(input: {
  profile: LanguageProfile;
  sourceVersionId: SourceVersionId;
  evidenceIds: EvidenceSpan["id"][];
  idFactory: IdFactory;
  hasher: Hasher;
}, unitKind: LanguageUnitRecord["unitKind"], text: string, features: string[], alpha: number): LanguageUnitRecord {
  return {
    id: input.idFactory.semanticId("language_unit", { profileId: input.profile.id, unitKind, text }),
    profileId: input.profile.id,
    sourceVersionId: input.sourceVersionId,
    script: scriptHint(text),
    unitKind,
    text,
    features,
    competenceVector: stableVector(features, input.hasher, 16),
    alpha,
    evidenceIds: input.evidenceIds.slice(0, 24),
    metadata: toJsonValue({ profileEntropy: input.profile.entropy, shape: shapeOf(text) })
  };
}

function compileLanguagePatterns(input: {
  profile: LanguageProfile;
  sourceVersionId: SourceVersionId;
  symbols: string[];
  evidence: EvidenceSpan[];
  evidenceIds: EvidenceSpan["id"][];
  createdAt: number;
  idFactory: IdFactory;
}): LanguagePatternRecord[] {
  const shapes = input.symbols.map(shapeOf);
  const shapeEntropy = entropy([...count(shapes).values()]);
  const transitionCounts = count(shapes.slice(1).map((shape, i) => `${shapes[i]}→${shape}`));
  const segmentSizes = input.evidence.map(span => symbolizeData(span.text).length);
  const patterns: Array<{ kind: LanguagePatternRecord["patternKind"]; support: number; entropy: number; payload: JsonValue }> = [
    { kind: "segmentation", support: clamp01(input.evidence.length / 64), entropy: entropy(segmentSizes), payload: toJsonValue({ segmentSizes: segmentSizes.slice(0, 256), sourceVersionId: input.sourceVersionId }) },
    { kind: "morphology", support: clamp01(new Set(shapes).size / Math.max(1, shapes.length)), entropy: shapeEntropy, payload: toJsonValue({ topShapes: topEntries(count(shapes), 128) }) },
    { kind: "syntax", support: clamp01(transitionCounts.size / Math.max(1, shapes.length)), entropy: entropy([...transitionCounts.values()]), payload: toJsonValue({ transitions: topEntries(transitionCounts, 128) }) },
    { kind: "cadence", support: clamp01(input.symbols.length / 8000), entropy: entropy(input.symbols.map(symbol => [...symbol].length)), payload: toJsonValue({ symbolLengths: topEntries(count(input.symbols.map(symbol => String([...symbol].length))), 64) }) },
    { kind: "semantic_role", support: clamp01(input.profile.charNgrams.length / 256), entropy: input.profile.entropy, payload: toJsonValue({ profileId: input.profile.id, scripts: input.profile.scripts }) }
  ];
  return patterns.map(pattern => ({
    id: input.idFactory.semanticId("language_pattern", { profileId: input.profile.id, kind: pattern.kind, payload: pattern.payload }),
    profileId: input.profile.id,
    patternKind: pattern.kind,
    support: pattern.support,
    entropy: pattern.entropy,
    patternJson: pattern.payload,
    evidenceIds: input.evidenceIds.slice(0, 64),
    updatedAt: input.createdAt
  }));
}

function semanticFrameForSpan(span: EvidenceSpan, index: number, profileId: string, idFactory: IdFactory, hasher: Hasher, createdAt: number): SemanticFrameRecord {
  const symbols = symbolizeData(span.text).slice(0, 256);
  const features = featureSet(span.text, 256);
  const roles = syntaxSignatures(symbols).slice(0, 16);
  const frameJson = toJsonValue({
    sourceVersionId: span.sourceVersionId,
    profileId,
    evidenceId: span.id,
    index,
    textHash: hasher.digestHex(span.text),
    preview: span.textPreview,
    symbolCount: symbols.length,
    featureSample: features.slice(0, 64),
    roleSignature: roles
  });
  return {
    id: idFactory.semanticId("semantic_frame", { profileId, evidenceId: span.id, hash: hasher.digestHex(span.text) }),
    frameJson,
    embedding: stableVector(features, hasher, 64),
    evidenceIds: [span.id],
    alpha: span.alpha,
    createdAt
  };
}

class SpaceSavingCounter<T> {
  readonly counts = new Map<T, { count: number; error: number }>();
  total = 0;
  constructor(readonly capacity: number, readonly order: number) {}
  get size(): number { return this.counts.size; }
  offer(key: T): void {
    this.total++;
    const current = this.counts.get(key);
    if (current) {
      current.count++;
      return;
    }
    if (this.counts.size < this.capacity) {
      this.counts.set(key, { count: 1, error: 0 });
      return;
    }
    let minKey: T | undefined;
    let min = Number.POSITIVE_INFINITY;
    for (const [candidate, value] of this.counts) {
      if (value.count < min) {
        min = value.count;
        minKey = candidate;
      }
    }
    if (minKey !== undefined) this.counts.delete(minKey);
    this.counts.set(key, { count: min + 1, error: min });
  }
  entries(): Array<{ key: T; count: number; error: number }> {
    return [...this.counts.entries()].map(([key, value]) => ({ key, count: value.count, error: value.error })).sort((a, b) => b.count - a.count);
  }
}

function primaryLanguageHint(profile: LanguageProfile): string {
  const script = profile.scripts.slice().sort((a, b) => b.mass - a.mass)[0]?.script ?? "unknown";
  return `script:${script};direction:${profile.direction}`;
}

function phraseCandidates(symbols: readonly string[]): Array<{ text: string; score: number }> {
  const grams = new Map<string, number>();
  for (let n = 2; n <= 6; n++) {
    for (let i = 0; i <= symbols.length - n; i++) {
      const gram = symbols.slice(i, i + n).join(" ");
      grams.set(gram, (grams.get(gram) ?? 0) + 1);
    }
  }
  const total = Math.max(1, symbols.length);
  return [...grams.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([text, count]) => ({ text, score: clamp01(Math.log2(count + 1) / Math.log2(total + 1)) }));
}

function syntaxSignatures(symbols: readonly string[]): Array<{ text: string; score: number }> {
  const windows = new Map<string, number>();
  const shapes = symbols.map(shapeOf);
  for (let n = 2; n <= 8; n++) {
    for (let i = 0; i <= shapes.length - n; i++) {
      const signature = shapes.slice(i, i + n).join(" ");
      windows.set(signature, (windows.get(signature) ?? 0) + 1);
    }
  }
  const total = Math.max(1, shapes.length);
  return [...windows.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([text, count]) => ({ text, score: clamp01(Math.log2(count + 1) / Math.log2(total + 1)) }));
}

function count(values: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const value of values) out.set(value, (out.get(value) ?? 0) + 1);
  return out;
}

function topEntries(map: Map<string, number>, limit: number): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
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
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const x = a[index]!.codePointAt(0)!;
    const y = b[index]!.codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}
