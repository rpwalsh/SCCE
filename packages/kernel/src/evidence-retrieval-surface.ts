import { sourceTextSurface } from "./primitives.js";
import type { EvidenceSpan } from "./types.js";

const DEFAULT_INDEX_CHARS = 6000;
const SOURCE_SCAN_MULTIPLIER = 2;

/**
 * Build the bounded source-derived surface used only for lexical/vector routing.
 * Full evidence remains attached to the selected proof path and answer construct.
 */
export function evidenceRetrievalSurface(
  span: Pick<EvidenceSpan, "text" | "textPreview">,
  maxChars = DEFAULT_INDEX_CHARS
): string {
  const safeLimit = Math.max(256, Math.floor(maxChars));
  const scanLimit = safeLimit * SOURCE_SCAN_MULTIPLIER;
  const preview = span.textPreview.slice(0, safeLimit);
  const source = span.text.slice(0, scanLimit);
  return sourceTextSurface(`${preview}\n${source}`, safeLimit);
}
