import type { LanguageMemoryRuntime, LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import { languageGenerationSurfaceAdequate } from "./language-memory-runtime.js";
import { namedSubjectAnchors } from "./kernel-answer-primitives.js";
import { collapseSurfaceWhitespace, splitSurfaceSentences, surfaceUnits } from "./surface-linguistics.js";
import type { LanguageProfile } from "./types.js";


export interface CreativeSectionRealizationInput {
  languageMemory: LanguageMemoryRuntime;
  state: LanguageMemoryRuntimeState;
  targetLanguageProfile?: LanguageProfile;
  requestText: string;
  sectionGoal: string;
  narrativeConditioning?: readonly string[];
  /** Words this section's prose should favor -- typically the request's own retrieved-evidence vocabulary, so word choice stays on-topic instead of drifting into an unrelated source's fingerprint. */
  topicVocabulary?: readonly string[];
  /**
   * The document's cast, already resolved by the caller when the request
   * text itself has none (a bare-pronoun follow-up like "write a story
   * about her") -- typically proper-noun anchors pulled from this turn's
   * own discourse-bound evidence. Used only as a fallback: a request that
   * names its own subject always wins on its own text.
   */
  resolvedCastSubjectIds?: readonly string[];
  /** Additional correctly-cased text (typically this turn's evidence) used only to recover proper-noun casing, never as content. */
  casingSourceTexts?: readonly string[];
  /** Distinct attempts sample distinct continuations for the same goal. */
  attempt?: number;
  generationExtent?: number;
  targetLanguage?: string;
  targetScript?: string;
}

export interface CreativeSectionRealization {
  text: string;
  accepted: boolean;
  reason: "ok" | "empty-generation" | "inadequate-surface" | "prompt-echo";
  generationAudit?: {
    stoppedBy: string;
    symbolCount: number;
    moveCount: number;
    averageInformation: number;
    confidence: number;
    rawTextChars: number;
  };
}

/**
 * Section-scoped call into the same generation engine the Mouth uses,
 * without the Mouth's per-turn pipeline cost. Fails closed with a
 * reason; prompts are never content.
 */
export function realizeCreativeSection(input: CreativeSectionRealizationInput): CreativeSectionRealization {
  const conditioning = (input.narrativeConditioning ?? []).filter(Boolean).slice(0, 6);
  // Proper-noun anchors only (casing shape, sentence-position corrected):
  // a purely structural signal, not a ranking over every word by length.
  // contentUnits' length ranking had no way to tell a request's own
  // instruction words ("write", "paragraph", "three") from its actual
  // subject -- live-verified: "write a three paragraph short story about
  // her" put "write"/"three"/"paragraph" into the story as characters.
  // A request with no capitalized subject (a pronoun, a common noun)
  // honestly yields no forced entity rather than a wrong one.
  // A section goal built from the request text ("... [part N of M]") has
  // the same emptiness a bare-pronoun request does -- the resolved cast
  // fallback applies here too, not just to the whole-request entity set.
  const resolvedCast = (input.resolvedCastSubjectIds ?? []).slice(0, 3);
  const goalUnits = properNounEntityAnchors(input.sectionGoal).length
    ? properNounEntityAnchors(input.sectionGoal).slice(0, 3)
    : resolvedCast;
  // One rotated unit per section owns the hard required-coverage
  // obligation (its opener varies instead of chanting every unit every
  // time) -- but the whole document's core entities (protagonist,
  // antagonist) are boosted in EVERY section. Rotating them away entirely
  // was the reason "Einstein" was absent from sections whose rotated
  // unit happened to land on a different word -- a multi-section
  // document has exactly one cast, present throughout.
  const rotation = goalUnits.length ? stableRotation(input.sectionGoal) % goalUnits.length : 0;
  const sectionUnit = goalUnits.length ? [goalUnits[rotation]!] : [];
  const persistentEntities = properNounEntityAnchors(input.requestText).length
    ? properNounEntityAnchors(input.requestText).slice(0, 3)
    : resolvedCast;
  const castTerms = [...new Set([...persistentEntities, ...sectionUnit])];
  // Evidence text is a casing source too, not just the request: a
  // pronoun follow-up ("...a story about her") contains none of the
  // subject's own words, so every name reaching the surface comes from
  // evidence and was rendered lowercase -- "Augusta ada king countess"
  // instead of "Augusta Ada King, Countess" (verified live).
  const properNounCasing = properNounCasingHints([
    input.requestText,
    input.sectionGoal,
    ...conditioning,
    ...(input.casingSourceTexts ?? [])
  ]);
  const generation = input.languageMemory.generate({
    state: input.state,
    targetLanguageProfile: input.targetLanguageProfile,
    // Unit symbols, not whole sentences: KN context matching is n-gram-sized.
    // The raw goal leads only to make each section's sampling seed distinct.
    contextSymbols: [
      `${collapseSurfaceWhitespace(input.sectionGoal)}attempt:${Math.max(1, Math.floor(input.attempt ?? 1))}`,
      ...contentUnits(input.requestText).slice(0, 8),
      ...conditioning.flatMap(line => contentUnits(line).slice(0, 4)),
      ...goalUnits
    ],
    frames: [{
      id: "frame:creative-section",
      role: "answer",
      force: "creative",
      // Whole-sentence atoms would force the output to embed the prompt --
      // which the echo gate forbids. Unit atoms and terms make coverage
      // mean "on topic", and the required-term seed steers the
      // continuation toward them.
      propositionAtoms: castTerms.map((unit, index) => ({
        id: `atom:creative-section:goal:${index}`,
        text: unit,
        kind: "surface",
        weight: 0.9,
        source: "section-plan"
      })),
      // The document's whole cast is a hard requirement of every section,
      // not just the section's own rotated emphasis -- a story keeps its
      // characters, it does not lose them section to section.
      requiredTerms: castTerms.map((unit, index) => ({
        id: `term:creative-section:goal:${index}`,
        text: unit,
        weight: 0.9,
        source: "section-plan"
      })),
      topicVocabulary: input.topicVocabulary,
      properNounCasing,
      targetLanguage: input.targetLanguage ?? "",
      targetScript: input.targetScript ?? ""
    }],
    generationExtent: Math.max(48, Math.min(320, Math.floor(input.generationExtent ?? 180)))
  });
  const generationAudit = {
    stoppedBy: generation.stoppedBy,
    symbolCount: generation.symbols.length,
    moveCount: generation.discourse.moves.length,
    averageInformation: generation.averageInformation,
    confidence: generation.confidence,
    rawTextChars: generation.text.length
  };
  const text = generation.text.trim();
  if (!text) return { text: "", accepted: false, reason: "empty-generation", generationAudit };
  if (!languageGenerationSurfaceAdequate(generation)) return { text: "", accepted: false, reason: "inadequate-surface", generationAudit };
  if (surfaceEchoesPrompt(text, input.sectionGoal) || surfaceEchoesPrompt(text, input.requestText)) {
    return { text: "", accepted: false, reason: "prompt-echo", generationAudit };
  }
  return { text, accepted: true, reason: "ok", generationAudit };
}

function stableRotation(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Training symbolization lowercases every symbol, so word casing is not
 * recoverable from the generation model -- only from the request text
 * itself. A Title-Case token that is not the sentence's first word is,
 * structurally, a proper noun (script-agnostic casing-shape check, no
 * word list); its lowercase form maps back to its original casing.
 */
function properNounCasingHints(texts: readonly string[]): Record<string, string> {
  const hints: Record<string, string> = {};
  for (const text of texts) {
    // Skip the first word of every SENTENCE, not just the first word of
    // the whole string -- conditioning is prior generated prose (often
    // several sentences), and treating only string-index-0 as sentence-
    // initial mislabeled every other sentence's ordinary opener ("The",
    // "They") as a proper noun, then applied that casing mid-sentence
    // everywhere the word recurred (verified live).
    for (const sentence of splitSurfaceSentences(text)) {
      const words = collapseSurfaceWhitespace(sentence).split(/\s+/u).filter(Boolean);
      for (let index = 1; index < words.length; index++) {
        const word = words[index]!.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
        if (word.length < 3) continue;
        const [first, ...rest] = [...word];
        if (!first || first !== first.toLocaleUpperCase() || first === first.toLocaleLowerCase()) continue;
        if (rest.some(char => char !== char.toLocaleLowerCase())) continue;
        hints[word.toLocaleLowerCase()] = word;
      }
    }
  }
  return hints;
}

function contentUnits(text: string): string[] {
  // Longer units carry more information; instruction words are short.
  return [...new Set(surfaceUnits(collapseSurfaceWhitespace(text).toLocaleLowerCase()))]
    .filter(unit => unit.length >= 3)
    .sort((left, right) => [...right].length - [...left].length);
}

/**
 * Proper-noun anchors from casing shape (namedSubjectAnchors), corrected
 * for the one false positive that check cannot see on its own: a word
 * capitalized only because it opens a sentence ("Write a five page
 * story...") is not a proper noun. A word is kept only if it is
 * capitalized somewhere that is NOT the first word of its sentence, or if
 * it is a multi-word run (["ada", "lovelace"] -- true names rarely double
 * as ordinary sentence openers).
 */
export function properNounEntityAnchors(text: string): string[] {
  const sentenceInitialWords = new Set(
    splitSurfaceSentences(text)
      .map(sentence => collapseSurfaceWhitespace(sentence).split(/\s+/u)[0])
      .filter((word): word is string => Boolean(word))
      .map(word => word.toLocaleLowerCase())
  );
  return namedSubjectAnchors(text).filter(anchor => {
    if (anchor.includes(" ")) return true;
    return !sentenceInitialWords.has(anchor.toLocaleLowerCase());
  });
}

/** Echo = normalized containment at comparable length, or >=0.8 unit overlap. */
export function surfaceEchoesPrompt(surface: string, prompt: string): boolean {
  const cleanSurface = collapseSurfaceWhitespace(surface).toLocaleLowerCase();
  const cleanPrompt = collapseSurfaceWhitespace(prompt).toLocaleLowerCase();
  if (!cleanSurface || !cleanPrompt) return false;
  if (cleanSurface === cleanPrompt) return true;
  const longer = cleanSurface.length >= cleanPrompt.length ? cleanSurface : cleanPrompt;
  const shorter = cleanSurface.length >= cleanPrompt.length ? cleanPrompt : cleanSurface;
  if (longer.includes(shorter) && longer.length <= shorter.length * 2) return true;
  const surfaceSet = new Set(surfaceUnits(cleanSurface).filter(unit => unit.length >= 3));
  const promptSet = new Set(surfaceUnits(cleanPrompt).filter(unit => unit.length >= 3));
  if (!surfaceSet.size || !promptSet.size) return false;
  let shared = 0;
  for (const unit of surfaceSet) if (promptSet.has(unit)) shared++;
  const union = surfaceSet.size + promptSet.size - shared;
  return union > 0 && shared / union >= 0.8;
}
