import type { LanguageMemoryRuntime, LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import { languageGenerationSurfaceAdequate } from "./language-memory-runtime.js";
import { collapseSurfaceWhitespace, surfaceUnits } from "./surface-linguistics.js";
import type { LanguageProfile } from "./types.js";

export interface CreativeSectionRealizationInput {
  languageMemory: LanguageMemoryRuntime;
  state: LanguageMemoryRuntimeState;
  targetLanguageProfile?: LanguageProfile;
  requestText: string;
  sectionGoal: string;
  narrativeConditioning?: readonly string[];
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
  const generation = input.languageMemory.generate({
    state: input.state,
    targetLanguageProfile: input.targetLanguageProfile,
    contextSymbols: [input.sectionGoal, input.requestText, ...conditioning],
    frames: [{
      id: "frame:creative-section",
      role: "point",
      force: "creative",
      // Atom coverage demands loose containment of the atom's full text, so
      // a whole-sentence goal atom would force the output to embed the
      // prompt -- which the echo gate then rejects. Unit atoms make
      // coverage mean "on topic" instead.
      propositionAtoms: [
        ...goalUnitAtoms(input.sectionGoal),
        ...conditioning.flatMap((line, index) =>
          contentUnits(line).slice(0, 4).map((unit, unitIndex) => ({
            id: `atom:creative-section:conditioning:${index}:${unitIndex}`,
            text: unit,
            kind: "narrative-conditioning",
            weight: 0.6,
            source: "narrative-state"
          }))
        )
      ],
      requiredTerms: [],
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

function contentUnits(text: string): string[] {
  // Longer units carry more information; instruction words are short.
  return [...new Set(surfaceUnits(collapseSurfaceWhitespace(text).toLocaleLowerCase()))]
    .filter(unit => unit.length >= 3)
    .sort((left, right) => [...right].length - [...left].length);
}

function goalUnitAtoms(sectionGoal: string): Array<{ id: string; text: string; kind: string; weight: number; source: string }> {
  const units = contentUnits(sectionGoal).slice(0, 4);
  if (!units.length) return [{ id: "atom:creative-section:goal", text: sectionGoal, kind: "goal", weight: 0.9, source: "section-plan" }];
  return units.map((unit, index) => ({
    id: `atom:creative-section:goal:${index}`,
    text: unit,
    kind: "goal",
    weight: 0.9,
    source: "section-plan"
  }));
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
