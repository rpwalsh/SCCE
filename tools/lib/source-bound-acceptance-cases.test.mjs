// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import test from "node:test";
import {
  dialoguePairBoundAcceptanceCase,
  firstSentenceWithDistinctiveTerms,
  lineWindowBoundAcceptanceCase,
  sentenceBoundAcceptanceCase
} from "./source-bound-acceptance-cases.mjs";

const sourceBindings = [{ sourceId: "source.1", sourceVersionId: "source_version.1", contentHash: "sha256_1" }];

test("sentence-bound facts cannot borrow an expectation from another sentence", () => {
  const sourceText = "Albedo is the fraction of sunlight that is diffusely reflected by a body. Fresh snow can be highly reflective.";
  const valid = sentenceBoundAcceptanceCase({
    id: "albedo", corpus: "wikipedia", question: "What is albedo?", sourceBindings, sourceText,
    sentenceFragments: ["Albedo is", "fraction of sunlight"],
    expectedAnswerTerms: ["fraction of sunlight", "diffusely reflected"]
  });
  assert.deepEqual(valid.expectedAnswerTerms, ["fraction of sunlight", "diffusely reflected"]);
  assert.throws(() => sentenceBoundAcceptanceCase({
    id: "albedo", corpus: "wikipedia", question: "What is albedo?", sourceBindings, sourceText,
    sentenceFragments: ["Albedo is", "fraction of sunlight"], expectedAnswerTerms: ["fresh snow"]
  }), /not present in its bounded support unit/u);
});

test("dialogue expectations come from the paired answer, not another turn", () => {
  const sourceText = "When did Virgin Australia start operating? Virgin Australia commenced services on 31 August 2000. What is its base? Brisbane.";
  assert.doesNotThrow(() => dialoguePairBoundAcceptanceCase({
    id: "dolly", corpus: "dolly", question: "When did Virgin Australia start operating?", sourceBindings, sourceText,
    pair: { prompt: "When did Virgin Australia start operating?", answer: "Virgin Australia commenced services on 31 August 2000." },
    expectedAnswerTerms: ["31 August 2000"]
  }));
  assert.throws(() => dialoguePairBoundAcceptanceCase({
    id: "dolly", corpus: "dolly", question: "When did Virgin Australia start operating?", sourceBindings, sourceText,
    pair: { prompt: "When did Virgin Australia start operating?", answer: "Virgin Australia commenced services on 31 August 2000." },
    expectedAnswerTerms: ["Brisbane"]
  }), /not present in its bounded support unit/u);
});

test("configuration expectations stay inside one anchored YAML list item", () => {
  const sourceText = "matrix:\n  include:\n  - build: pinned\n    os: ubuntu-latest\n    rust: 1.60.0\n  - build: pinned-win\n    os: windows-latest\n    rust: 1.60.0\n  - build: nightly\n    os: ubuntu-latest\n    rust: nightly";
  assert.doesNotThrow(() => lineWindowBoundAcceptanceCase({
    id: "walkdir-ci", corpus: "code", question: "Which Rust version does the pinned build use?", sourceBindings, sourceText,
    anchorLine: "- build: pinned", windowLines: 3, expectedAnswerTerms: ["1.60.0"]
  }));
  assert.throws(() => lineWindowBoundAcceptanceCase({
    id: "walkdir-ci", corpus: "code", question: "Which Rust version does the pinned build use?", sourceBindings, sourceText,
    anchorLine: "- build: pinned", windowLines: 3, expectedAnswerTerms: ["nightly"]
  }), /not present in its bounded support unit/u);
});

test("generic fallback term selection is bounded to one sentence", () => {
  const selected = firstSentenceWithDistinctiveTerms("Alpha sentence contains sunlight. Second sentence contains unrelated nightly.",
    text => text.toLowerCase().match(/[a-z]{5,}/gu) ?? []);
  assert.match(selected.sentence, /^Alpha sentence/u);
  assert.equal(selected.terms.includes("nightly"), false);
  const none = firstSentenceWithDistinctiveTerms("One. Another sentence has a term that must not leak.", () => []);
  assert.equal(none.sentence, "One.");
  assert.deepEqual(none.terms, []);
});
