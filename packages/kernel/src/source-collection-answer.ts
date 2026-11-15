// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { unicodeLexicalSegments } from "./unicode-segmentation.js";
import { lexicalRelationWitnesses } from "./lexical-semantic-memory.js";
import { learnedAnswerUnitFormVerdict } from "./learned-answer-unit-forms.js";
import { evidenceWindowText } from "./evidence-retrieval-surface.js";
import type { EvidenceSpan } from "./types.js";

interface SourceListSection { heading: string; members: string[] }
const units = (text: string) => unicodeLexicalSegments(text).map(unit => unit.normalized);
const sameForm = (left: string, right: string) => left === right || learnedAnswerUnitFormVerdict(left, right).status === "same";

/** Membership comes from the source's list structure and its heading, never the spelling of a name. */
export function sourceListSections(text: string): SourceListSection[] {
  const sections: SourceListSection[] = [];
  let current: SourceListSection | undefined;
  for (const line of text.split(/\r?\n/u)) {
    const heading = /^\s*(?:=+\s*(.*?)\s*=+|#+\s+(.+?)\s*#*|([^\r\n]+):)\s*$/u.exec(line);
    if (heading) {
      current = { heading: heading[1] ?? heading[2] ?? heading[3]!, members: [] };
      sections.push(current);
      continue;
    }
    const member = /^\s*(?:[*+\-•]|\p{N}+[.)])\s+(.+?)\s*$/u.exec(line);
    if (current && member) current.members.push(member[1]!);
  }
  return sections.filter(section => section.members.length > 0);
}

export function sourceCollectionForRequest(input: { requestText: string; evidence: readonly EvidenceSpan[];
  closedClassWords: ReadonlySet<string>; titleForEvidence: (span: EvidenceSpan) => string }):
  { members: string[]; evidence: EvidenceSpan[]; excerpts: Array<{ text: string; evidenceId: EvidenceSpan["id"] }> } | undefined {
  const results = input.evidence.flatMap(span => {
    const titleUnits = units(input.titleForEvidence(span));
    const relationUnits = units(input.requestText).filter(unit => !input.closedClassWords.has(unit)
      && !titleUnits.some(title => sameForm(unit, title)));
    if (!relationUnits.length) return [];
    return sourceListSections(evidenceWindowText(span)).filter(section => {
      const headingUnits = units(section.heading);
      return relationUnits.every(unit => headingUnits.some(heading => sameForm(unit, heading)
        || lexicalRelationWitnesses(unit, heading, section.heading, input.closedClassWords).length > 0));
    }).map(section => ({ span, section }));
  });
  if (!results.length) return undefined;
  const members = [...new Set(results.flatMap(result => result.section.members))];
  const evidence = [...new Map(results.map(result => [result.span.id, result.span])).values()];
  const excerpts = results.flatMap(result => result.section.members.map(text => ({ text, evidenceId: result.span.id })));
  return { members, evidence, excerpts };
}
