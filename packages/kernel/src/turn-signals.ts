// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { EvidenceSpan, RequestedAuthority } from "./types.js";
import type { KneserNeyModel } from "./kneser-ney.js";
import type { LanguageContinuationPopulation, LanguagePatternRecord } from "./storage.js";
import { deriveClosedClassWords, requestClosedClassWords } from "./closed-class-words.js";
import { namedSubjectAnchors } from "./kernel-answer-primitives.js";
import {
  evidenceIdentityBindsRequest,
  requestSentenceSequences,
  sourceEvidenceAnchorsForRequest,
  spanContainsRequestNearDuplicateSentence
} from "./local-evidence-runtime.js";
import { requestSubjectText, type TurnRequirementField } from "./turn-requirements.js";

/**
 * What is true about this turn, computed once, for every gate that needs it.
 *
 * Each of these facts already had a function, and each was called at some decision sites and approximated at
 * others -- so a gate reached for whatever was cheap and local, and the stand-in became load-bearing. Measured
 * over one day: "is this recall?" read `plan.audit.nearDuplicate`, a flag set only when the ranker happened to
 * take that path, while the fact ("the request quotes a sentence an admitted span contains") sat one call away;
 * "is this source about the subject?" read a title substring while the source's own identity was in the row;
 * "which span leads?" read `charStart === 0`, which agrees with the real answer on an encyclopedia and disagrees
 * on every book. The proxies agree with the facts on 94% of this corpus, which is why they survived.
 *
 * A signal is derived on first use and kept: a turn asks the same questions of the same request many times.
 */
export interface TurnSignals {
  /** The request as asked. */
  readonly text: string;
  /** The subject, with the spans the routing patterns matched removed: what the request is about, not what it asks for. */
  readonly subjectText: string;
  /** Source anchors for the request, in the one normalization retrieval and admission share. */
  readonly anchors: readonly string[];
  /** The proper-noun subjects the request names. */
  readonly namedSubjects: readonly string[];
  /** Sentence sequences the request quotes; non-empty means the request carries someone else's sentence. */
  readonly sentenceSequences: readonly (readonly string[])[];
  /** The request's own learned scaffolding, by continuation count, for this authority. */
  readonly closedClassWords: ReadonlySet<string>;
  /** What the corpus treats as function material, whatever this request says. */
  readonly functionSymbols: ReadonlySet<string>;
  /** Whether the request quotes a sentence one of these spans contains -- the fact "this turn is recall" rests on. */
  quotesSource(evidence: readonly EvidenceSpan[]): boolean;
  /** Whether a source's own identity binds this request's subject -- the fact "this source is about it" rests on. */
  identityBinds(span: EvidenceSpan): boolean;
}

export interface TurnSignalsInput {
  requestText: string;
  authority: RequestedAuthority;
  requirementField: TurnRequirementField;
  models: readonly KneserNeyModel[];
  continuationPopulation?: LanguageContinuationPopulation;
  patterns: readonly LanguagePatternRecord[];
}

export function createTurnSignals(input: TurnSignalsInput): TurnSignals {
  let subjectText: string | undefined;
  let anchors: readonly string[] | undefined;
  let namedSubjects: readonly string[] | undefined;
  let sequences: readonly (readonly string[])[] | undefined;
  let closedClass: ReadonlySet<string> | undefined;
  let functionSymbols: ReadonlySet<string> | undefined;

  const signals: TurnSignals = {
    text: input.requestText,
    get subjectText(): string {
      return (subjectText ??= requestSubjectText(input.requestText, input.requirementField));
    },
    get anchors(): readonly string[] {
      return (anchors ??= sourceEvidenceAnchorsForRequest(input.requestText));
    },
    get namedSubjects(): readonly string[] {
      return (namedSubjects ??= namedSubjectAnchors(input.requestText));
    },
    get sentenceSequences(): readonly (readonly string[])[] {
      return (sequences ??= requestSentenceSequences(input.requestText));
    },
    get closedClassWords(): ReadonlySet<string> {
      return (closedClass ??= requestClosedClassWords({
        requestText: input.requestText,
        models: input.models,
        continuationPopulation: input.continuationPopulation,
        patterns: input.patterns,
        authority: input.authority
      }));
    },
    get functionSymbols(): ReadonlySet<string> {
      return (functionSymbols ??= deriveClosedClassWords({ models: input.models, continuationPopulation: input.continuationPopulation }));
    },
    quotesSource(evidence: readonly EvidenceSpan[]): boolean {
      const requestSequences = signals.sentenceSequences;
      if (!requestSequences.length) return false;
      return evidence.some(span => spanContainsRequestNearDuplicateSentence(span, requestSequences));
    },
    identityBinds(span: EvidenceSpan): boolean {
      return evidenceIdentityBindsRequest(span, input.requestText, signals.closedClassWords);
    }
  };
  return signals;
}
