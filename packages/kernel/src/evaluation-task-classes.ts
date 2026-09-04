// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
/**
 * Plan item 231. The preregistered task classes for the signed blind
 * evaluation gate, as a real typed config artifact -- not prose. Every
 * `PairedResultRecord.taskFamilyId` (`paired-evaluation-statistics.ts`,
 * items 232-234) a real evaluation run produces is expected to name one
 * of these ids; nothing here computes a score itself.
 */

export interface PreregisteredTaskClass {
  id: string;
  label: string;
  description: string;
}

export const PREREGISTERED_TASK_CLASSES: readonly PreregisteredTaskClass[] = Object.freeze([
  { id: "factual_qa", label: "Factual QA", description: "Direct factual questions with a single verifiable answer." },
  { id: "closed_graph_knowledge", label: "Closed-graph knowledge", description: "Questions answerable only from the system's own ingested graph, no external world knowledge." },
  { id: "long_context_synthesis", label: "Long-context synthesis", description: "Combining facts spread across multiple sources/passages into one answer." },
  { id: "temporal_contradiction_reasoning", label: "Temporal/contradiction reasoning", description: "Questions requiring reconciling or exposing genuinely contradictory or time-scoped claims." },
  { id: "multilingual_interpretation", label: "Multilingual interpretation", description: "Understanding a request in a non-English script or language." },
  { id: "translation", label: "Translation", description: "Producing a faithful target-language rendering of a source-language text." },
  { id: "long_form_prose", label: "Long-form prose", description: "Extended generated prose (multi-paragraph document, narrative, or explanation)." },
  { id: "cross_turn_correction", label: "Cross-turn correction", description: "Incorporating an explicit user correction from an earlier turn into a later answer." },
  { id: "code_understanding", label: "Code understanding", description: "Answering questions about the real behavior or structure of source code." },
  { id: "defect_localization", label: "Defect localization", description: "Identifying which real symbol/file a described bug is most likely in." },
  { id: "repository_patching", label: "Repository patching", description: "Producing a real, minimal, byte-preserving patch for a described change or bug." },
  { id: "planning", label: "Planning", description: "Decomposing a goal into a real, checkable, dependency-ordered task sequence." },
  { id: "tool_use", label: "Tool use", description: "Correctly selecting and invoking a real capability/tool to accomplish part of a request." }
]);

const TASK_CLASS_IDS: ReadonlySet<string> = new Set(PREREGISTERED_TASK_CLASSES.map(taskClass => taskClass.id));

export function isPreregisteredTaskClassId(id: string): boolean {
  return TASK_CLASS_IDS.has(id);
}

/** Real validation, not advisory: throws naming every unregistered id found, rather than silently accepting an ad hoc task-family label into the evaluation gate. */
export function assertPreregisteredTaskClassIds(taskFamilyIds: readonly string[]): void {
  const unknown = [...new Set(taskFamilyIds.filter(id => !TASK_CLASS_IDS.has(id)))].sort();
  if (unknown.length) {
    throw new Error(`unregistered task class id(s), not part of the preregistered evaluation gate: ${unknown.join(", ")}`);
  }
}
