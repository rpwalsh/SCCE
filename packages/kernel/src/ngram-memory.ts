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
  sourceSystem?: string;
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
            metadata: toJsonValue({ profileId: input.profile.id, ...(input.sourceSystem ? { sourceSystem: input.sourceSystem } : {}), error: entry.error, approximate: entry.error > 0, evidenceIds: evidenceIds.slice(0, 16) })
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
          ...(input.sourceSystem ? { sourceSystem: input.sourceSystem } : {}),
          languageHint,
          model,
          compact: compactKneserNeyForProfile(model, input.text)
        }),
        updatedAt: input.createdAt
      } satisfies NgramModelRecord));
      const units = compileLanguageUnits({ profile: input.profile, sourceVersionId: input.sourceVersionId, sourceSystem: input.sourceSystem, symbols, evidenceIds, alpha, idFactory: options.idFactory, hasher: options.hasher });
      const patterns = compileLanguagePatterns({ profile: input.profile, sourceVersionId: input.sourceVersionId, sourceSystem: input.sourceSystem, text: input.text, symbols, evidence: input.evidence, evidenceIds, createdAt: input.createdAt, idFactory: options.idFactory });
      const semanticFrames = input.evidence.slice(0, 512).map((span, index) => semanticFrameForSpan(
        span,
        index,
        input.profile.id,
        options.idFactory,
        options.hasher,
        input.createdAt,
        input.sourceSystem
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
          sourceSystem: input.sourceSystem ?? null,
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
  sourceSystem?: string;
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
  sourceSystem?: string;
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
    metadata: toJsonValue({ profileEntropy: input.profile.entropy, ...(input.sourceSystem ? { sourceSystem: input.sourceSystem } : {}), shape: shapeOf(text) })
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
}): LanguagePatternRecord[] {
  const shapes = input.symbols.map(shapeOf);
  const shapeEntropy = entropy([...count(shapes).values()]);
  const transitionCounts = count(shapes.slice(1).map((shape, i) => `${shapes[i]}→${shape}`));
  const segmentSizes = input.evidence.map(span => symbolizeData(span.text).length);
  const discourse = longFormDiscoursePattern(input.text, input.sourceSystem, input.sourceVersionId);
  const narrative = narrativeSurfacePattern(input.text, input.sourceSystem, input.sourceVersionId);
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

function longFormDiscoursePattern(text: string, sourceSystem: string | undefined, sourceVersionId: SourceVersionId): { support: number; entropy: number; payload: JsonValue } {
  const paragraphs = paragraphSurfaces(text);
  const sentences = sentenceSurfaces(text);
  const sentenceSymbolLengths = sentences.map(sentence => symbolizeData(sentence).length).filter(length => length > 0);
  const paragraphSymbolLengths = paragraphs.map(paragraph => symbolizeData(paragraph).length).filter(length => length > 0);
  const boundaryCounts = count(boundarySurfaces(text));
  const connectorCounts = count(sentences.map(sentence => openingPhrase(sentence, 3)).filter(nonemptyString));
  const paragraphOpeningCounts = count(paragraphs.map(paragraph => openingPhrase(paragraph, 4)).filter(nonemptyString));
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

function narrativeSurfacePattern(text: string, sourceSystem: string | undefined, sourceVersionId: SourceVersionId): { support: number; entropy: number; payload: JsonValue } {
  const paragraphs = paragraphSurfaces(text);
  const sentences = sentenceSurfaces(text);
  const symbols = symbolizeData(text);
  const anchors = repeatedAnchorSurfaces(symbols);
  const paragraphShapes = paragraphs.map(paragraph => paragraphShape(paragraph));
  const sentenceOpenings = sentences.map(sentence => openingPhrase(sentence, 2)).filter(nonemptyString);
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

function semanticFrameForSpan(span: EvidenceSpan, index: number, profileId: string, idFactory: IdFactory, hasher: Hasher, createdAt: number, sourceSystem?: string): SemanticFrameRecord {
  const symbols = symbolizeData(span.text).slice(0, 256);
  const features = featureSet(span.text, 256);
  const roles = syntaxSignatures(symbols).slice(0, 16);
  const frameJson = toJsonValue({
    sourceVersionId: span.sourceVersionId,
    profileId,
    ...(sourceSystem ? { sourceSystem } : {}),
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

function openingPhrase(text: string, maxSymbols: number): string {
  return symbolizeData(text)
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

function paragraphShape(paragraph: string): string {
  const sentences = sentenceSurfaces(paragraph).length;
  const symbols = symbolizeData(paragraph).length;
  const dialogue = dialogueTurnSurfaces(paragraph).length > 0 ? "dialogue" : "prose";
  const length = symbols < 40 ? "short" : symbols < 140 ? "medium" : "long";
  return `${dialogue}:${length}:${Math.min(8, sentences)}`;
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
