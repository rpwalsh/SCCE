import type { EvidenceSpan, JsonValue, LanguageProfile, SourceId, SourceTrust, SourceVersionId } from "./types.js";
import type { IdFactory } from "./ids.js";
import type { Hasher } from "./types.js";
import { anchorFeatureSet, clamp01, entropy, featureSet, symbolizeData, toJsonValue } from "./primitives.js";

export interface EvidenceExtractionInput {
  sourceId: SourceId;
  sourceVersionId: SourceVersionId;
  namespace: string;
  uri: string;
  mediaType: string;
  text: string;
  languageProfile: LanguageProfile;
  sourceTrust: SourceTrust;
  observedAt: number;
  maxChunkBytes: number;
  metadata?: JsonValue;
  exactSourceText?: boolean;
}

export interface ExtractedEvidence {
  spans: EvidenceSpan[];
  sections: SectionBoundary[];
  diagnostics: EvidenceExtractionDiagnostics;
}

export interface SectionBoundary {
  index: number;
  title: string;
  charStart: number;
  charEnd: number;
  byteStart: number;
  byteEnd: number;
  depth: number;
}

export interface EvidenceExtractionDiagnostics {
  byteLength: number;
  charLength: number;
  symbolCount: number;
  spanCount: number;
  sectionCount: number;
  meanSpanBytes: number;
  lexicalEntropy: number;
  structuralConfidence: number;
  warnings: string[];
}

export function createEvidenceExtractor(deps: { idFactory: IdFactory; hasher: Hasher }) {
  return {
    extract(input: EvidenceExtractionInput): ExtractedEvidence {
      // Exact source derivatives are already canonical and must not be rewritten.
      // The legacy/default NFC path remains for callers that intentionally bind
      // their source version to normalized bytes.
      const normalized = input.exactSourceText
        ? input.text
        : input.text.replace(/\u0000/g, " ").normalize("NFC");
      const byteIndex = buildByteIndex(normalized);
      const sections = detectSections(normalized, byteIndex);
      const chunks = segmentByParagraphs(normalized, input.maxChunkBytes, byteIndex);
      const symbols = symbolizeData(normalized);
      const lexicalEntropy = entropy(symbols.map(symbol => Math.max(1, symbol.length)));
      const structuralConfidence = computeStructuralConfidence({ text: normalized, mediaType: input.mediaType, sections, chunks });
      const warnings = diagnosticsWarnings(input, normalized, chunks);
      const spans: EvidenceSpan[] = chunks.map((chunk, index) => {
        const chunkBytes = Buffer.from(chunk.text, "utf8");
        const contentHash = deps.idFactory.contentHash(chunkBytes);
        const chunkId = deps.idFactory.chunkId({ sourceVersionId: input.sourceVersionId, byteStart: chunk.byteStart, byteEnd: chunk.byteEnd, chunkHash: contentHash });
        const evidenceId = deps.idFactory.evidenceId({ sourceVersionId: input.sourceVersionId, byteStart: chunk.byteStart, byteEnd: chunk.byteEnd, spanHash: contentHash });
        const structural = sectionForChunk(sections, chunk);
        const features = evidenceFeatures(chunk.text, structural, index);
        const alpha = evidenceAlpha({ features, structuralConfidence, chunk, lexicalEntropy, mediaType: input.mediaType });
        return {
          id: evidenceId,
          sourceId: input.sourceId,
          sourceVersionId: input.sourceVersionId,
          chunkId,
          contentHash,
          mediaType: input.mediaType,
          byteStart: chunk.byteStart,
          byteEnd: chunk.byteEnd,
          charStart: chunk.charStart,
          charEnd: chunk.charEnd,
          text: chunk.text,
          textPreview: compactPreview(chunk.text),
          languageHints: {
            profileId: input.languageProfile.id,
            scripts: input.languageProfile.scripts.slice(0, 6),
            direction: input.languageProfile.direction,
            symbolShapes: input.languageProfile.symbolShapes.slice(0, 12)
          },
          scriptHints: {
            direction: input.languageProfile.direction,
            dominantScripts: input.languageProfile.scripts.slice(0, 4),
            section: structural ? { title: structural.title, depth: structural.depth, index: structural.index } : null
          },
          trustVector: {
            namespace: input.namespace,
            sourceTrust: input.sourceTrust,
            structuralConfidence,
            lexicalEntropy,
            mediaType: input.mediaType,
            warnings: warnings.slice(0, 4)
          },
          provenance: {
            uri: input.uri,
            sourceVersionId: input.sourceVersionId,
            chunkHash: contentHash,
            extractor: extractorName(input.mediaType),
            charRange: [chunk.charStart, chunk.charEnd],
            byteRange: [chunk.byteStart, chunk.byteEnd],
            section: structural ? structural.title : null,
            metadata: input.metadata ?? null
          },
          features,
          status: "quarantined",
          alpha,
          observedAt: input.observedAt
        };
      });
      return {
        spans,
        sections,
        diagnostics: {
          byteLength: Buffer.byteLength(normalized, "utf8"),
          charLength: [...normalized].length,
          symbolCount: symbols.length,
          spanCount: spans.length,
          sectionCount: sections.length,
          meanSpanBytes: spans.length ? spans.reduce((sum, span) => sum + (span.byteEnd - span.byteStart), 0) / spans.length : 0,
          lexicalEntropy,
          structuralConfidence,
          warnings
        }
      };
    }
  };
}

interface ByteIndexedChar {
  char: string;
  charStart: number;
  charEnd: number;
  byteStart: number;
  byteEnd: number;
}

interface ChunkBoundary {
  text: string;
  charStart: number;
  charEnd: number;
  byteStart: number;
  byteEnd: number;
}

function buildByteIndex(text: string): ByteIndexedChar[] {
  const out: ByteIndexedChar[] = [];
  let charOffset = 0;
  let byteOffset = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    out.push({ char, charStart: charOffset, charEnd: charOffset + 1, byteStart: byteOffset, byteEnd: byteOffset + size });
    charOffset++;
    byteOffset += size;
  }
  return out;
}

function segmentByParagraphs(text: string, maxBytes: number, byteIndex: ByteIndexedChar[]): ChunkBoundary[] {
  const paragraphs = paragraphBoundaries(text, byteIndex);
  const chunks: ChunkBoundary[] = [];
  let current: ChunkBoundary | undefined;
  for (const paragraph of paragraphs) {
    if (!paragraph.text.trim()) continue;
    const nextBytes = (current ? current.byteEnd - current.byteStart : 0) + (paragraph.byteEnd - paragraph.byteStart);
    if (current && nextBytes > maxBytes) {
      chunks.push(current);
      current = undefined;
    }
    if (paragraph.byteEnd - paragraph.byteStart > maxBytes) {
      chunks.push(...splitOversized(paragraph, maxBytes, byteIndex));
      continue;
    }
    current = current ? mergeChunks(current, paragraph, text) : paragraph;
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : text ? [{ text, charStart: 0, charEnd: [...text].length, byteStart: 0, byteEnd: Buffer.byteLength(text, "utf8") }] : [];
}

function paragraphBoundaries(text: string, byteIndex: ByteIndexedChar[]): ChunkBoundary[] {
  const out: ChunkBoundary[] = [];
  const re = /\S[\s\S]*?(?=\n\s*\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const raw = match[0];
    const charStart = codePointOffsetAtUtf16(text, match.index);
    const charEnd = charStart + [...raw].length;
    out.push({ text: raw, charStart, charEnd, byteStart: byteAt(byteIndex, charStart), byteEnd: byteAt(byteIndex, charEnd) });
    if (match.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

function splitOversized(chunk: ChunkBoundary, maxBytes: number, byteIndex: ByteIndexedChar[]): ChunkBoundary[] {
  const out: ChunkBoundary[] = [];
  let start = chunk.charStart;
  let cursor = chunk.charStart;
  let bytes = 0;
  const chars = [...chunk.text];
  for (const char of chars) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes > 0 && bytes + size > maxBytes) {
      const relativeStart = start - chunk.charStart;
      const relativeEnd = cursor - chunk.charStart;
      out.push(boundary(chars.slice(relativeStart, relativeEnd).join(""), start, cursor, byteIndex));
      start = cursor;
      bytes = 0;
    }
    bytes += size;
    cursor++;
  }
  if (cursor > start) {
    const relativeStart = start - chunk.charStart;
    out.push(boundary(chars.slice(relativeStart).join(""), start, cursor, byteIndex));
  }
  return out;
}

function boundary(text: string, charStart: number, charEnd: number, byteIndex: ByteIndexedChar[]): ChunkBoundary {
  return { text, charStart, charEnd, byteStart: byteAt(byteIndex, charStart), byteEnd: byteAt(byteIndex, charEnd) };
}

function mergeChunks(left: ChunkBoundary, right: ChunkBoundary, fullText: string): ChunkBoundary {
  return {
    text: sliceByCodePoints(fullText, left.charStart, right.charEnd),
    charStart: left.charStart,
    charEnd: right.charEnd,
    byteStart: left.byteStart,
    byteEnd: right.byteEnd
  };
}

function byteAt(byteIndex: ByteIndexedChar[], charOffset: number): number {
  if (charOffset <= 0) return 0;
  if (charOffset >= byteIndex.length) return byteIndex[byteIndex.length - 1]?.byteEnd ?? 0;
  return byteIndex[charOffset]?.byteStart ?? byteIndex[byteIndex.length - 1]?.byteEnd ?? 0;
}

function codePointOffsetAtUtf16(text: string, utf16Offset: number): number {
  if (utf16Offset <= 0) return 0;
  return [...text.slice(0, utf16Offset)].length;
}

function sliceByCodePoints(text: string, start: number, end: number): string {
  return [...text].slice(start, end).join("");
}

function detectSections(text: string, byteIndex: ByteIndexedChar[]): SectionBoundary[] {
  const sections: SectionBoundary[] = [];
  const linePattern = /[^\n]*(?:\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(text))) {
    const lineWithEnding = match[0];
    if (!lineWithEnding) break;
    const line = lineWithEnding.endsWith("\n") ? lineWithEnding.slice(0, -1) : lineWithEnding;
    const trimmed = line.trim();
    const markdown = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    const numbered = /^(\d+(?:\.\d+)*)\s+(.{3,160})$/.exec(trimmed);
    const allCaps = trimmed.length >= 4 && trimmed.length <= 96 && trimmed === trimmed.toUpperCase() && /\p{Letter}/u.test(trimmed);
    if (markdown || numbered || allCaps) {
      const title = markdown ? markdown[2] ?? trimmed : numbered ? numbered[2] ?? trimmed : trimmed;
      const depth = markdown ? (markdown[1]?.length ?? 1) : numbered ? (numbered[1]?.split(".").length ?? 1) : 1;
      const utf16Start = match.index + line.indexOf(trimmed);
      const utf16End = utf16Start + trimmed.length;
      const charStart = codePointOffsetAtUtf16(text, utf16Start);
      const charEnd = codePointOffsetAtUtf16(text, utf16End);
      sections.push({
        index: sections.length,
        title: title.trim(),
        depth,
        charStart,
        charEnd,
        byteStart: byteAt(byteIndex, charStart),
        byteEnd: byteAt(byteIndex, charEnd)
      });
    }
  }
  return sections;
}

function sectionForChunk(sections: SectionBoundary[], chunk: ChunkBoundary): SectionBoundary | undefined {
  let selectedBoundary: SectionBoundary | undefined;
  for (const section of sections) {
    if (section.charStart <= chunk.charStart) selectedBoundary = section;
    else break;
  }
  return selectedBoundary;
}

function evidenceFeatures(text: string, section: SectionBoundary | undefined, index: number): string[] {
  const base = featureSet(text, 900);
  const anchors = anchorFeatureSet(text, 256);
  const structural = [`span-index:${Math.floor(index / 4)}`, `span-mod:${index % 4}`];
  if (section) structural.push(`section:${section.title.toLowerCase()}`, `section-depth:${section.depth}`);
  const density = symbolizeData(text).length / Math.max(1, [...text].length);
  structural.push(`density:${Math.round(density * 100)}`);
  return [...new Set([...anchors, ...base, ...structural])].sort().slice(0, 1100);
}

function evidenceAlpha(input: { features: string[]; structuralConfidence: number; chunk: ChunkBoundary; lexicalEntropy: number; mediaType: string }): number {
  const byteMass = Math.log2(2 + Math.max(0, input.chunk.byteEnd - input.chunk.byteStart)) / 18;
  const featureMass = Math.log2(2 + input.features.length) / 14;
  const entropyMass = clamp01(input.lexicalEntropy / 12);
  const mediaPrior = input.mediaType.includes("pdf") || input.mediaType.includes("word") ? 0.72 : input.mediaType.startsWith("text/") ? 0.78 : 0.62;
  return clamp01(0.12 + 0.25 * byteMass + 0.25 * featureMass + 0.18 * input.structuralConfidence + 0.12 * entropyMass + 0.08 * mediaPrior);
}

function computeStructuralConfidence(input: { text: string; mediaType: string; sections: SectionBoundary[]; chunks: ChunkBoundary[] }): number {
  const lineCount = input.text.split(/\n/).length;
  const sectionMass = clamp01(Math.log2(1 + input.sections.length) / 5);
  const chunkMass = input.chunks.length > 0 ? 0.45 : 0;
  const lineMass = clamp01(Math.log2(1 + lineCount) / 8);
  const mediaMass = input.mediaType.startsWith("text/") || input.mediaType.includes("pdf") || input.mediaType.includes("word") ? 0.8 : 0.55;
  return clamp01(0.2 * sectionMass + 0.35 * chunkMass + 0.25 * lineMass + 0.2 * mediaMass);
}

function diagnosticsWarnings(input: EvidenceExtractionInput, text: string, chunks: ChunkBoundary[]): string[] {
  const warnings: string[] = [];
  if (!text.trim()) warnings.push("empty-text");
  if (Buffer.byteLength(text, "utf8") > input.maxChunkBytes && chunks.length <= 1) warnings.push("chunking-did-not-split-large-source");
  if (!input.mediaType) warnings.push("missing-media-type");
  if (input.languageProfile.entropy < 0.25) warnings.push("low-language-entropy");
  return warnings;
}

function extractorName(mediaType: string): string {
  if (mediaType.includes("pdf")) return "pdf-text-layout";
  if (mediaType.includes("word") || mediaType.includes("officedocument")) return "docx-xml-text";
  if (mediaType.startsWith("image/")) return "ocr-text";
  if (mediaType.includes("spreadsheet") || mediaType.includes("excel")) return "spreadsheet-cells";
  return "unicode-text";
}

function compactPreview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 700);
}

export function evidenceAuditRecord(span: EvidenceSpan): JsonValue {
  return toJsonValue({
    id: span.id,
    sourceVersionId: span.sourceVersionId,
    byteRange: [span.byteStart, span.byteEnd],
    charRange: [span.charStart, span.charEnd],
    contentHash: span.contentHash,
    featureCount: span.features.length,
    alpha: span.alpha,
    status: span.status,
    provenance: span.provenance
  });
}
