// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { literalBits, scoreConstructionGrammarMdl, type ConstructionGrammarMdlScore } from "./construction-grammar-mdl.js";
import type { LearnedConstruction, LearnedFormClass } from "./language-construction.js";
import type { PairedAntiUnifiedConstruction } from "./paired-anti-unification.js";

export const CONSTRUCTION_GRAMMAR_SELECTION_SCHEMA = "scce.construction_grammar_selection.v1" as const;

export interface ConstructionGrammarSelection {
  schema: typeof CONSTRUCTION_GRAMMAR_SELECTION_SCHEMA;
  retainedConstructionIds: string[];
  pruned: Array<{ constructionId: string; grammarBits: number; spelledOutBits: number }>;
  score: ConstructionGrammarMdlScore;
}

/** A generalized construction is kept only when encoding its own examples through it costs fewer bits than spelling them out. */
export function selectConstructionGrammarByDescriptionLength(input: {
  constructions: readonly PairedAntiUnifiedConstruction[];
}): { retained: PairedAntiUnifiedConstruction[]; selection: ConstructionGrammarSelection } {
  const retained: PairedAntiUnifiedConstruction[] = [];
  const pruned: ConstructionGrammarSelection["pruned"] = [];
  for (const construction of input.constructions) {
    const grammarBits = scoreConstructionGrammarMdl(projectGrammar([construction])).totalBits;
    const spelledOutBits = exampleSurfaces(construction).reduce((sum, surface) => sum + literalBits(surface), 0);
    if (spelledOutBits > 0 && grammarBits < spelledOutBits) retained.push(construction);
    else pruned.push({ constructionId: construction.id, grammarBits, spelledOutBits });
  }
  return {
    retained,
    selection: {
      schema: CONSTRUCTION_GRAMMAR_SELECTION_SCHEMA,
      retainedConstructionIds: retained.map(construction => construction.id),
      pruned,
      score: scoreConstructionGrammarMdl(projectGrammar(retained))
    }
  };
}

/** Each source construction's full surface, rebuilt from the program with that source's own slot fills. */
export function exampleSurfaces(construction: PairedAntiUnifiedConstruction): string[] {
  return construction.sourceConstructionIds.flatMap(sourceId => {
    let surface = "";
    for (const part of construction.surfaceProgram.parts) {
      if (part.kind === "literal") { surface += part.surface; continue; }
      if (part.mode === "fixed") { surface += part.fixedSurface ?? ""; continue; }
      const example = part.examples.find(row => row.constructionId === sourceId);
      if (!example) return [];
      surface += example.observedSurface;
    }
    return [surface];
  });
}

// The scorer reads only sequence, sourceExampleIds and variant origins; the rest of the learned shapes is not needed to cost a grammar.
function projectGrammar(constructions: readonly PairedAntiUnifiedConstruction[]): {
  constructions: LearnedConstruction[];
  formClasses: LearnedFormClass[];
} {
  const learned: LearnedConstruction[] = [];
  const formClasses: LearnedFormClass[] = [];
  for (const construction of constructions) {
    const sequence = construction.surfaceProgram.parts.map(part => {
      if (part.kind === "literal") return { kind: "literal", surface: part.surface };
      if (part.mode === "fixed") return { kind: "literal", surface: part.fixedSurface ?? "" };
      const formClassId = `${construction.id}:${part.id}`;
      const counts = new Map<string, number>();
      for (const example of part.examples) counts.set(example.observedSurface, (counts.get(example.observedSurface) ?? 0) + 1);
      formClasses.push({
        id: formClassId,
        constructionId: construction.id,
        variants: [...counts].map(([surface, count]) => ({ surface, origins: Array.from({ length: count }, () => ({})) }))
      } as unknown as LearnedFormClass);
      return { kind: "slot", formClassId };
    });
    learned.push({
      id: construction.id,
      sequence,
      sourceExampleIds: construction.sourceConstructionIds
    } as unknown as LearnedConstruction);
  }
  return { constructions: learned, formClasses };
}
