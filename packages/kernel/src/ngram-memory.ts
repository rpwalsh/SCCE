// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
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
import { compactKneserNeyForProfile, persistedKneserNey, trainKneserNey } from "./kneser-ney.js";
import { clamp01, entropy, symbolizeData, toJsonValue } from "./primitives.js";
import { corpusRoleIdForSourceSystem } from "./corpus-registry.js";
import { canonicalNgramModelId } from "./source-language-training-identity.js";
import {
  bindNgramModelTrainingReplay,
  captureKneserNeyTrainingReplay
} from "./kneser-ney-training-replay.js";
import {
  deriveSourceLanguageArtifacts,
  normalizeSourceLanguageArtifactCompilerOptions,
  type SourceLanguageArtifactDerivationMeasurement,
  type SourceLanguageArtifactDerivationReceipt
} from "./source-language-artifact-derivation.js";

export interface NgramMemoryCompilation {
  observations: NgramObservation[];
  models: NgramModelRecord[];
  units: LanguageUnitRecord[];
  patterns: LanguagePatternRecord[];
  semanticFrames: SemanticFrameRecord[];
  sourceArtifactDerivation: {
    receipt: SourceLanguageArtifactDerivationReceipt;
    measurement: SourceLanguageArtifactDerivationMeasurement;
  };
  audit: JsonValue;
}

export interface NgramMemoryInput {
  streamId: string;
  sourceSystem?: string;
  profile: LanguageProfile;
  sourceVersionId: SourceVersionId;
  text: string;
  evidence: EvidenceSpan[];
  createdAt: number;
  maxOrder?: number;
  maxCountersPerOrder?: number;
  vocabularyLimit?: number;
  retainObservations?: boolean;
  retainSemanticFrames?: boolean;
}

export function createNgramMemoryCompiler(options: { idFactory: IdFactory; hasher: Hasher }) {
  return {
    compile(input: NgramMemoryInput): NgramMemoryCompilation {
      const compilerOptions = normalizeSourceLanguageArtifactCompilerOptions(input);
      const derivedArtifacts = deriveSourceLanguageArtifacts({
        streamId: input.streamId,
        sourceSystem: input.sourceSystem,
        profile: input.profile,
        sourceVersionId: input.sourceVersionId,
        text: input.text,
        evidence: input.evidence,
        createdAt: input.createdAt,
        compilerOptions,
        idFactory: options.idFactory,
        hasher: options.hasher
      });
      const { sourceSystem, formalCode, symbols, graphemes } = derivedArtifacts.projection;
      const maxOrder = compilerOptions.maxOrder;
      const maxCounters = compilerOptions.maxCountersPerOrder;
      const languageHint = primaryLanguageHint(input.profile);
      const evidenceIds = input.evidence.map(span => span.id);
      const alpha = input.evidence.length ? input.evidence.reduce((sum, span) => sum + span.alpha, 0) / input.evidence.length : 0.35;
      const counters = compilerOptions.retainObservations ? Array.from({ length: maxOrder }, (_, i) => new SpaceSavingCounter<string>(maxCounters, i + 1)) : [];
      for (let i = 0; counters.length && i < symbols.length; i++) {
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
            metadata: toJsonValue({ profileId: input.profile.id, ...(sourceSystem ? { sourceSystem: sourceSystem } : {}), error: entry.error, approximate: entry.error > 0, evidenceIds: evidenceIds.slice(0, 16) })
          } satisfies NgramObservation;
        });
      });
      const vocabularyLimit = compilerOptions.vocabularyLimit;
      const kneserNeyModels = [trainKneserNey(symbols, { order: maxOrder, discount: 0.75, vocabularyLimit })];
      const models = kneserNeyModels.map(model => {
        const record = {
          id: canonicalNgramModelId({ streamId: input.streamId, sourceSystem, profileId: input.profile.id, languageHint, order: model.order, sourceVersionId: input.sourceVersionId, hasher: options.hasher }),
          streamId: input.streamId,
          languageHint,
          maxOrder: model.order,
          discount: model.discount,
          modelJson: toJsonValue({
            sourceVersionId: input.sourceVersionId,
            profileId: input.profile.id,
            ...(sourceSystem ? { sourceSystem: sourceSystem } : {}),
            languageHint,
            model: persistedKneserNey(model),
            compact: compactKneserNeyForProfile(model, input.text)
          }),
          updatedAt: input.createdAt
        } satisfies NgramModelRecord;
        bindNgramModelTrainingReplay(record, captureKneserNeyTrainingReplay({
          symbols,
          model,
          vocabularyLimit,
          hasher: options.hasher
        }));
        return record;
      });
      const units = derivedArtifacts.units;
      const patterns = formalCode ? [] : compileLanguagePatterns({ profile: input.profile, sourceVersionId: input.sourceVersionId, sourceSystem: sourceSystem, text: input.text, symbols, evidence: input.evidence, evidenceIds, createdAt: input.createdAt, idFactory: options.idFactory, hasher: options.hasher });
      const semanticFrames = derivedArtifacts.semanticFrames;
      return {
        observations,
        models,
        units,
        patterns,
        semanticFrames,
        sourceArtifactDerivation: {
          receipt: derivedArtifacts.receipt,
          measurement: derivedArtifacts.measurement
        },
        audit: toJsonValue({
          streamId: input.streamId,
          sourceVersionId: input.sourceVersionId,
          sourceSystem: sourceSystem ?? null,
          languageHint,
          surfaceLatticeId: derivedArtifacts.projection.surfaceLatticeId ?? null,
          corpusRole: sourceSystem ? corpusRoleIdForSourceSystem(sourceSystem) : null,
          surfaceLatticeSchema: derivedArtifacts.projection.surfaceLatticeSchema ?? null,
          sourceTextHash: derivedArtifacts.projection.sourceTextHash,
          trainingOptions: { maxOrder, maxCountersPerOrder: maxCounters, vocabularyLimit },
          symbolCount: symbols.length,
          graphemeCount: graphemes.length,
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

function compileLanguagePatterns(input: {
  profile: LanguageProfile;
  sourceVersionId: SourceVersionId;
  sourceSystem?: string;
  text: string;
  symbols: string[];
  evidence: EvidenceSpan[];
  evidenceIds: EvidenceSpan["id"][];
  createdAt: number;
  idFactory: IdFactory;
  hasher: Hasher;
}): LanguagePatternRecord[] {
  const shapes = input.symbols.map(shapeOf);
  const shapeEntropy = entropy([...count(shapes).values()]);
  const transitionCounts = count(shapes.slice(1).map((shape, i) => `${shapes[i]}→${shape}`));
  const segmentSizes = input.evidence.map(span => surfaceSymbols(span.text, String(span.id), input.hasher).length);
  const discourse = longFormDiscoursePattern(input.text, input.sourceSystem, input.sourceVersionId, input.hasher);
  const narrative = narrativeSurfacePattern(input.text, input.sourceSystem, input.sourceVersionId, input.hasher);
  const patterns: Array<{ kind: LanguagePatternRecord["patternKind"]; support: number; entropy: number; payload: JsonValue }> = [
    { kind: "segmentation", support: clamp01(input.evidence.length / 64), entropy: entropy(segmentSizes), payload: toJsonValue({ ...(input.sourceSystem ? { sourceSystem: input.sourceSystem } : {}), segmentSizes: segmentSizes.slice(0, 256), sourceVersionId: input.sourceVersionId }) },
    { kind: "morphology", support: clamp01(new Set(shapes).size / Math.max(1, shapes.length)), entropy: shapeEntropy, payload: toJsonValue({ ...(input.sourceSystem ? { sourceSystem: input.sourceSystem } : {}), topShapes: topEntries(count(shapes), 128) }) },
    { kind: "syntax", support: clamp01(transitionCounts.size / Math.max(1, shapes.length)), entropy: entropy([...transitionCounts.values()]), payload: toJsonValue({ ...(input.sourceSystem ? { sourceSystem: input.sourceSystem } : {}), transitions: topEntries(transitionCounts, 128) }) },
    { kind: "cadence", support: clamp01(input.symbols.length / 8000), entropy: entropy(input.symbols.map(symbol => [...symbol].length)), payload: toJsonValue({ ...(input.sourceSystem ? { sourceSystem: input.sourceSystem } : {}), symbolLengths: topEntries(count(input.symbols.map(symbol => String([...symbol].length))), 64) }) },
    { kind: "discourse", support: discourse.support, entropy: discourse.entropy, payload: discourse.payload },
    { kind: "narrative", support: narrative.support, entropy: narrative.entropy, payload: narrative.payload },
    { kind: "semantic_role", support: clamp01(input.profile.charNgrams.length / 256), entropy: input.profile.entropy, payload: toJsonValue({ ...(input.sourceSystem ? { sourceSystem: input.sourceSystem } : {}), profileId: input.profile.id, scripts: input.profile.scripts }) }
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

function longFormDiscoursePattern(text: string, sourceSystem: string | undefined, sourceVersionId: SourceVersionId, hasher: Hasher): { support: number; entropy: number; payload: JsonValue } {
  const paragraphs = paragraphSurfaces(text);
  const sentences = sentenceSurfaces(text);
  const sentenceSymbolLengths = sentences.map((sentence, index) => surfaceSymbols(sentence, `discourse.sentence.${index}`, hasher).length).filter(length => length > 0);
  const paragraphSymbolLengths = paragraphs.map((paragraph, index) => surfaceSymbols(paragraph, `discourse.paragraph.${index}`, hasher).length).filter(length => length > 0);
  const boundaryCounts = count(boundarySurfaces(text));
  const connectorCounts = count(sentences.map((sentence, index) => openingPhrase(sentence, 3, hasher, `discourse.connector.${index}`)).filter(nonemptyString));
  const paragraphOpeningCounts = count(paragraphs.map((paragraph, index) => openingPhrase(paragraph, 4, hasher, `discourse.opening.${index}`)).filter(nonemptyString));
  const dialogueMarkers = dialogueTurnSurfaces(text);
  const payload = toJsonValue({
    schema: "scce.long_form_discourse_pattern.v1",
    ...(sourceSystem ? { sourceSystem } : {}),
    sourceVersionId,
    sentenceCount: sentences.length,
    paragraphCount: paragraphs.length,
    sentenceSymbolLengths: sentenceSymbolLengths.slice(0, 512),
    paragraphSymbolLengths: paragraphSymbolLengths.slice(0, 256),
    boundaryCounts: topEntries(boundaryCounts, 32),
    connectors: topEntries(connectorCounts, 64),
    paragraphOpenings: topEntries(paragraphOpeningCounts, 64),
    dialogueTurnMarkers: topEntries(count(dialogueMarkers), 32),
    counts: Object.fromEntries(topEntries(connectorCounts, 64))
  });
  return {
    support: clamp01((sentences.length + paragraphs.length * 2 + dialogueMarkers.length) / 128),
    entropy: entropy([...boundaryCounts.values(), ...connectorCounts.values(), ...paragraphSymbolLengths]),
    payload
  };
}

function narrativeSurfacePattern(text: string, sourceSystem: string | undefined, sourceVersionId: SourceVersionId, hasher: Hasher): { support: number; entropy: number; payload: JsonValue } {
  const paragraphs = paragraphSurfaces(text);
  const sentences = sentenceSurfaces(text);
  const symbols = surfaceSymbols(text, `narrative.${String(sourceVersionId)}`, hasher);
  const anchors = repeatedAnchorSurfaces(symbols);
  const paragraphShapes = paragraphs.map((paragraph, index) => paragraphShape(paragraph, hasher, `narrative.paragraph.${index}`));
  const sentenceOpenings = sentences.map((sentence, index) => openingPhrase(sentence, 2, hasher, `narrative.opening.${index}`)).filter(nonemptyString);
  const dialogueTurns = dialogueTurnSurfaces(text);
  const payload = toJsonValue({
    schema: "scce.narrative_surface_pattern.v1",
    ...(sourceSystem ? { sourceSystem } : {}),
    sourceVersionId,
    paragraphShapeTransitions: topEntries(count(paragraphShapes.slice(1).map((shape, index) => `${paragraphShapes[index]}→${shape}`)), 64),
    repeatedAnchors: topEntries(count(anchors), 128),
    sentenceOpenings: topEntries(count(sentenceOpenings), 64),
    dialogueTurnRate: ratioNumber(dialogueTurns.length, Math.max(1, paragraphs.length)),
    anchorReuseRate: ratioNumber(anchors.length, Math.max(1, symbols.length)),
    counts: Object.fromEntries(topEntries(count([...anchors, ...sentenceOpenings]), 128))
  });
  return {
    support: clamp01((paragraphs.length + sentences.length + anchors.length) / 160),
    entropy: entropy([...count(paragraphShapes).values(), ...count(anchors).values(), ...count(sentenceOpenings).values()]),
    payload
  };
}

function paragraphSurfaces(text: string): string[] {
  return text
    .normalize("NFC")
    .split(/(?:\r?\n){2,}/u)
    .map(value => value.trim())
    .filter(nonemptyString)
    .slice(0, 512);
}

function sentenceSurfaces(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const char of text.normalize("NFC")) {
    current += char;
    if (isSentenceBoundarySurface(char) || current.length >= 800) {
      const clean = current.trim();
      if (clean) out.push(clean);
      current = "";
    }
  }
  const tail = current.trim();
  if (tail) out.push(tail);
  return out.slice(0, 2048);
}

function boundarySurfaces(text: string): string[] {
  const values: string[] = [];
  for (const char of text.normalize("NFC")) {
    if (isSentenceBoundarySurface(char)) values.push(char);
  }
  return values;
}

function dialogueTurnSurfaces(text: string): string[] {
  const markers: string[] = [];
  for (const rawLine of text.normalize("NFC").split(/\r?\n/u).slice(0, 4096)) {
    const line = rawLine.trimStart();
    const first = line[0] ?? "";
    if (first === "\"" || first === "'" || first === "\u201c" || first === "\u2018" || first === "\u300c" || first === "\u300e" || first === "\u2014" || first === "\u2013") {
      markers.push(first);
    }
  }
  return markers;
}

function openingPhrase(text: string, maxSymbols: number, hasher: Hasher, documentId: string): string {
  return surfaceSymbols(text, documentId, hasher)
    .filter(symbol => !isSentenceBoundarySurface(symbol))
    .slice(0, Math.max(1, maxSymbols))
    .join(" ")
    .trim();
}

function repeatedAnchorSurfaces(symbols: readonly string[]): string[] {
  const normalized = symbols
    .map(symbol => symbol.normalize("NFKC").toLocaleLowerCase())
    .filter(symbol => symbol.length >= 3 && !isSentenceBoundarySurface(symbol));
  const counts = count(normalized);
  return [...counts.entries()]
    .filter(([, value]) => value >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 256)
    .map(([symbol]) => symbol);
}

function paragraphShape(paragraph: string, hasher: Hasher, documentId: string): string {
  const sentences = sentenceSurfaces(paragraph).length;
  const symbols = surfaceSymbols(paragraph, documentId, hasher).length;
  const dialogue = dialogueTurnSurfaces(paragraph).length > 0 ? "dialogue" : "prose";
  const length = symbols < 40 ? "short" : symbols < 140 ? "medium" : "long";
  return `${dialogue}:${length}:${Math.min(8, sentences)}`;
}

/**
 * Lightweight tokenization for the descriptive pattern helpers below
 * (opening-phrase previews, paragraph-shape buckets, per-sentence/
 * paragraph length stats, semantic-frame symbol slices) -- never the
 * corpus's actual induced language model, which already has its own real
 * lattice built once in `compile()` above and reads from that directly.
 *
 * Measured root cause of a confirmed pathological cost (a single 8KB
 * document taking ~14s inside compileLanguagePatterns, against ~2.5s for
 * everything else in the whole compile pass combined): this function
 * previously called `buildSurfaceLattice` -- real boundary-estimator-
 * driven segmentation -- and callers invoke it once PER SENTENCE and once
 * PER PARAGRAPH. For ordinary prose that is dozens to hundreds of full
 * lattice constructions per document, each paying real fixed overhead, to
 * extract a handful of leading tokens or a length count. `symbolizeData`
 * is the same real, tested, script-agnostic Unicode segmenter already
 * used at this exact scale elsewhere (`featureSet`, `primitives.ts`) --
 * no boundary-estimator statistics, no grapheme-candidate machinery,
 * because none of these callers need that precision.
 */
function surfaceSymbols(text: string, _documentId: string, _hasher: Hasher): string[] {
  return symbolizeData(text);
}

function isSentenceBoundarySurface(value: string): boolean {
  return value === "." || value === "!" || value === "?" || value === "\u3002" || value === "\uff01" || value === "\uff1f";
}

function nonemptyString(value: string): boolean {
  return value.trim().length > 0;
}

function ratioNumber(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

class SpaceSavingCounter<T> {
  readonly counts = new Map<T, { count: number; error: number; version: number; insertedAt: number }>();
  private heap: Array<{ key: T; count: number; version: number; insertedAt: number }> = [];
  private sequence = 0;
  total = 0;
  constructor(readonly capacity: number, readonly order: number) {}
  get size(): number { return this.counts.size; }
  offer(key: T): void {
    this.total++;
    const current = this.counts.get(key);
    if (current) {
      current.count++;
      current.version++;
      this.pushHeap({ key, count: current.count, version: current.version, insertedAt: current.insertedAt });
      this.compactHeapIfNeeded();
      return;
    }
    if (this.counts.size < this.capacity) {
      const value = { count: 1, error: 0, version: 0, insertedAt: this.sequence++ };
      this.counts.set(key, value);
      this.pushHeap({ key, count: value.count, version: value.version, insertedAt: value.insertedAt });
      return;
    }
    const minimum = this.popCurrentMinimum();
    if (!minimum) throw new Error("space-saving counter heap lost its current minimum");
    this.counts.delete(minimum.key);
    const value = {
      count: minimum.count + 1,
      error: minimum.count,
      version: 0,
      insertedAt: this.sequence++
    };
    this.counts.set(key, value);
    this.pushHeap({ key, count: value.count, version: value.version, insertedAt: value.insertedAt });
    this.compactHeapIfNeeded();
  }
  entries(): Array<{ key: T; count: number; error: number }> {
    return [...this.counts.entries()].map(([key, value]) => ({ key, count: value.count, error: value.error })).sort((a, b) => b.count - a.count);
  }

  private compactHeapIfNeeded(): void {
    if (this.heap.length <= Math.max(64, this.capacity * 4)) return;
    this.heap = [...this.counts.entries()].map(([key, value]) => ({
      key,
      count: value.count,
      version: value.version,
      insertedAt: value.insertedAt
    }));
    for (let index = Math.floor(this.heap.length / 2) - 1; index >= 0; index--) this.siftDown(index);
  }

  private popCurrentMinimum(): { key: T; count: number } | undefined {
    while (this.heap.length) {
      const candidate = this.popHeap()!;
      const current = this.counts.get(candidate.key);
      if (current
        && current.version === candidate.version
        && current.count === candidate.count
        && current.insertedAt === candidate.insertedAt) {
        return { key: candidate.key, count: candidate.count };
      }
    }
    return undefined;
  }

  private pushHeap(entry: { key: T; count: number; version: number; insertedAt: number }): void {
    this.heap.push(entry);
    let index = this.heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.heapLess(index, parent)) break;
      [this.heap[index], this.heap[parent]] = [this.heap[parent]!, this.heap[index]!];
      index = parent;
    }
  }

  private popHeap(): { key: T; count: number; version: number; insertedAt: number } | undefined {
    const first = this.heap[0];
    if (!first) return undefined;
    const last = this.heap.pop()!;
    if (this.heap.length === 0) return first;
    this.heap[0] = last;
    this.siftDown(0);
    return first;
  }

  private siftDown(start: number): void {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.heap.length && this.heapLess(left, smallest)) smallest = left;
      if (right < this.heap.length && this.heapLess(right, smallest)) smallest = right;
      if (smallest === index) return;
      [this.heap[index], this.heap[smallest]] = [this.heap[smallest]!, this.heap[index]!];
      index = smallest;
    }
  }

  private heapLess(leftIndex: number, rightIndex: number): boolean {
    const left = this.heap[leftIndex]!;
    const right = this.heap[rightIndex]!;
    return left.count < right.count || (left.count === right.count && left.insertedAt < right.insertedAt);
  }
}

function primaryLanguageHint(profile: LanguageProfile): string {
  const script = profile.scripts.slice().sort((a, b) => b.mass - a.mass)[0]?.script ?? "unknown";
  return `script:${script};direction:${profile.direction}`;
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
