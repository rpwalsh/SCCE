// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

function normalized(value) {
  return String(value ?? "").normalize("NFC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function nonemptyStrings(values, label) {
  if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== "string" || !value.trim())) {
    throw new Error(`${label} must contain non-empty strings`);
  }
  return values;
}

function sentenceUnits(sourceText) {
  const text = String(sourceText ?? "").replace(/\r\n?/gu, "\n").trim();
  if (!text) return [];
  return (text.match(/[^.!?\n]+(?:[.!?]+[\])}"'’”]*|$)/gu) ?? [])
    .map(value => value.trim())
    .filter(Boolean);
}

function uniqueUnit(units, requiredFragments, label) {
  const fragments = nonemptyStrings(requiredFragments, `${label} fragments`).map(normalized);
  const matches = units.filter(unit => fragments.every(fragment => normalized(unit).includes(fragment)));
  if (matches.length !== 1) {
    throw new Error(`${label} must identify exactly one committed support unit; found ${matches.length}`);
  }
  return matches[0];
}

function validateCaseFields({ id, corpus, question, sourceBindings }) {
  if (typeof id !== "string" || !id.trim() || typeof corpus !== "string" || !corpus.trim()
    || typeof question !== "string" || !question.trim()) {
    throw new Error("source-bound acceptance case requires id, corpus, and question");
  }
  if (!Array.isArray(sourceBindings) || !sourceBindings.length) {
    throw new Error(`${id} requires at least one committed source binding`);
  }
}

function acceptanceCase(options, supportingUnit) {
  validateCaseFields(options);
  const all = Array.isArray(options.expectedAnswerTerms) ? options.expectedAnswerTerms : [];
  const any = Array.isArray(options.expectedAnyAnswerTerms) ? options.expectedAnyAnswerTerms : [];
  if (!all.length && !any.length) throw new Error(`${options.id} requires an answer expectation`);
  for (const term of [...all, ...any]) {
    if (typeof term !== "string" || !term.trim() || !normalized(supportingUnit).includes(normalized(term))) {
      throw new Error(`${options.id} expectation is not present in its bounded support unit: ${term}`);
    }
  }
  return {
    id: options.id,
    corpus: options.corpus,
    requestedAuthority: options.requestedAuthority ?? "factual",
    question: options.question,
    ...(all.length ? { expectedAnswerTerms: [...all] } : {}),
    ...(any.length ? { expectedAnyAnswerTerms: [...any] } : {}),
    sourceBindings: options.sourceBindings
  };
}

export function sentenceBoundAcceptanceCase(options) {
  const support = uniqueUnit(sentenceUnits(options.sourceText), options.sentenceFragments, `${options.id} sentence`);
  return acceptanceCase(options, support);
}

export function dialoguePairBoundAcceptanceCase(options) {
  const prompt = normalized(options.pair?.prompt);
  const answer = String(options.pair?.answer ?? "").trim();
  if (!prompt || !answer) throw new Error(`${options.id} requires a prompt/answer pair`);
  const source = normalized(options.sourceText);
  const promptIndex = source.indexOf(prompt);
  const answerIndex = source.indexOf(normalized(answer), promptIndex < 0 ? 0 : promptIndex + prompt.length);
  if (promptIndex < 0 || answerIndex < 0) throw new Error(`${options.id} prompt/answer pair is not present in the committed source`);
  return acceptanceCase(options, answer);
}

export function lineWindowBoundAcceptanceCase(options) {
  const lines = String(options.sourceText ?? "").replace(/\r\n?/gu, "\n").split("\n");
  const width = Number.isInteger(options.windowLines) && options.windowLines > 0 ? options.windowLines : 3;
  const anchorLine = typeof options.anchorLine === "string" && options.anchorLine.trim() ? normalized(options.anchorLine) : null;
  const fragments = anchorLine ? [] : nonemptyStrings(options.anchorFragments, `${options.id} line-window fragments`).map(normalized);
  const starts = lines.flatMap((line, index) => {
    const value = normalized(line);
    return (anchorLine ? value === anchorLine : fragments.every(fragment => value.includes(fragment))) ? [index] : [];
  });
  if (starts.length !== 1) throw new Error(`${options.id} line-window anchor must identify exactly one line; found ${starts.length}`);
  return acceptanceCase(options, lines.slice(starts[0], starts[0] + width).join("\n"));
}

export function firstSentenceWithDistinctiveTerms(sourceText, distinctiveTerms) {
  const units = sentenceUnits(sourceText);
  for (const sentence of units) {
    const terms = distinctiveTerms(sentence);
    if (terms.length) return { sentence, terms };
  }
  return { sentence: units[0] ?? "", terms: [] };
}
