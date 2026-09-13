// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// One grader for every head-to-head runner (live server, ablated in-process runtimes): the verdict of an item must not
// depend on which harness asked the question.
// ---- scoring ------------------------------------------------------------------------------------------------
export const normalize = value => String(value).replace(/\s+/gu, " ").trim().toLowerCase();
export const declines = answer => {
  const spoken = normalize(answer);
  if (!spoken) return true;
  return /(do not|does not|doesn't|don't|no (information|mention|reference|record|grounded source)|not (mentioned|found|provided|present|specified|available|contain|include)|cannot|can't|unable|unknown|not enough|isn't (mentioned|specified)|no specific)/u.test(spoken);
};
export function score(item, answer) {
  const spoken = normalize(answer);
  const declined = declines(answer);
  if (item.gold.ungraded) return { verdict: "ungraded", declined };
  if (item.gold.unanswerable) return { verdict: declined ? "declined" : "fabricated", declined };
  const forbidden = (item.gold.forbiddenStrings ?? []).some(s => spoken.includes(normalize(s)));
  const required = (item.gold.requiredStrings ?? []);
  const accepted = (item.gold.acceptedAnswers ?? []);
  const hasRequired = required.length
    ? required.every(s => normalize(s).split(/[\s,]+/u).filter(Boolean).every(part => spoken.includes(part)))
    : accepted.some(s => spoken.includes(normalize(s)));
  if (forbidden) return { verdict: "wrong", declined };
  if (hasRequired) return { verdict: "correct", declined };
  return { verdict: declined ? "declined_when_answerable" : "wrong", declined };
}

