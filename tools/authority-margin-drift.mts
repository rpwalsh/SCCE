// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// What 79f6136's rescaling did to the scoreMargin gates in production-turn-runtime, replayed offline over the
// requirement fields recorded live on 2026-09-16. Run: pnpm --dir packages/kernel exec vite-node ../../tools/authority-margin-drift.mts
import {
  authorityReplayRows,
  distinctAuthorityReplayRows,
  liveProjection,
  replayProjection,
  replayableAuthorityRow,
  scoreRequestAuthorityAtAbsoluteLevel,
  type ReplayRow
} from "../packages/kernel/src/__tests__/fixtures/authority-projection-replay.js";
import { REQUESTED_AUTHORITY_IDS, operationalAuthorityForProjection, scoreRequestAuthority } from "../packages/kernel/src/request-authority.js";
import { COGNITIVE_OPERATOR_IDS } from "../packages/kernel/src/turn-requirements.js";
import type { RequestedAuthority } from "../packages/kernel/src/types.js";

type Scorer = typeof scoreRequestAuthority;

const recorded = authorityReplayRows();
const replayable = recorded.filter(replayableAuthorityRow);
const rows = distinctAuthorityReplayRows();
console.log(`recorded rows ${recorded.length}; replayable ${replayable.length} (the rest had inferentialDepth overwritten by composition demand after projection); distinct projector inputs ${rows.length}`);

// Instrument check: the absolute-level replay must reproduce what the server recorded before the commit.
let reproducedAbsolute = 0;
let reproducedDeviation = 0;
for (const row of replayable) {
  const before = replayProjection(row.field, scoreRequestAuthorityAtAbsoluteLevel);
  const after = replayProjection(row.field, scoreRequestAuthority);
  if (before.projectedAuthority === row.recordedAuthority && Math.abs(before.scoreMargin - row.recordedMargin) < 2e-3) reproducedAbsolute++;
  else if (after.projectedAuthority === row.recordedAuthority && Math.abs(after.scoreMargin - row.recordedMargin) < 2e-3) reproducedDeviation++;
}
console.log(`live rows reproduced: absolute-level ${reproducedAbsolute}, deviation ${reproducedDeviation}, neither ${replayable.length - reproducedAbsolute - reproducedDeviation}`);
console.log(`replay disagreeing with projectRequestAuthority: ${rows.filter(row => {
  const live = liveProjection(row.field);
  const now = replayProjection(row.field, scoreRequestAuthority);
  return live.projectedAuthority !== now.projectedAuthority || Math.abs(live.scoreMargin - now.scoreMargin) > 1e-12;
}).length}`);

function requestedAuthorityFor(row: ReplayRow, score: Scorer): RequestedAuthority {
  const replayed = replayProjection(row.field, score);
  const scores = Object.fromEntries(REQUESTED_AUTHORITY_IDS.map(authority => [authority, score(row.field, authority)])) as Record<RequestedAuthority, number>;
  return operationalAuthorityForProjection({
    projection: {
      schema: "scce.requested_authority.requirement_projection.v2",
      requestedAuthority: replayed.projectedAuthority,
      selectedAuthority: replayed.projectedAuthority,
      projectedAuthority: replayed.projectedAuthority,
      explicitOverride: false,
      scores,
      scoreMargin: replayed.scoreMargin,
      contributionPresent: replayed.contributionPresent,
      authorityEvidenceMagnitude: 0,
      authorityScoreSpread: replayed.authorityScoreSpread,
      authorityDistinguishable: replayed.authorityDistinguishable,
      trace: null
    },
    activeOperatorIds: [
      ...(row.programPlanningActive ? [COGNITIVE_OPERATOR_IDS.programPlanning] : []),
      ...(row.actionPlanningActive ? [COGNITIVE_OPERATOR_IDS.actionPlanning] : [])
    ]
  });
}

const recallEligible = (authority: RequestedAuthority) => authority !== "factual" && authority !== "program" && authority !== "action";
const tally = new Map<string, number>();
const bump = (key: string) => tally.set(key, (tally.get(key) ?? 0) + 1);

for (const row of rows) {
  const before = replayProjection(row.field, scoreRequestAuthorityAtAbsoluteLevel);
  const after = replayProjection(row.field, scoreRequestAuthority);
  const authorityBefore = requestedAuthorityFor(row, scoreRequestAuthorityAtAbsoluteLevel);
  const authorityAfter = requestedAuthorityFor(row, scoreRequestAuthority);
  bump(`authority ${authorityBefore} -> ${authorityAfter}`);

  // Sites 1770 and 1876: sourceAnchoringRequired.
  const anchorBefore = authorityBefore !== "creative" || before.scoreMargin < 0.12;
  const anchorAfter = authorityAfter !== "creative" || after.scoreMargin < 0.12;
  const anchorNamed = authorityAfter !== "creative" || !after.authorityDistinguishable;
  if (anchorBefore) bump("1770/1876 anchors, absolute era");
  if (anchorAfter) bump("1770/1876 anchors, deviation era (today)");
  if (anchorNamed) bump("1770/1876 anchors, named separation (this lane)");
  if (anchorBefore !== anchorAfter) bump("1770/1876 CHANGED by the rescaling");
  if (anchorAfter !== anchorNamed) bump("1770/1876 CHANGED by this lane");

  // Site 2383: memoryDecidesAuthority, with its answerProposal conjunct assumed satisfied.
  const memoryBefore = recallEligible(authorityBefore) && before.scoreMargin < 0.12;
  const memoryAfter = recallEligible(authorityAfter) && after.scoreMargin < 0.12;
  const memoryNamed = recallEligible(authorityAfter) && !after.authorityDistinguishable;
  if (memoryBefore) bump(`2383 fires, absolute era (on ${authorityBefore})`);
  if (memoryAfter) bump(`2383 fires, deviation era (on ${authorityAfter})`);
  if (memoryNamed) bump("2383 fires, named separation");
  if (memoryBefore !== memoryAfter) bump("2383 CHANGED by the rescaling");
  if (memoryAfter !== memoryNamed) bump("2383 CHANGED by substituting the named boolean");
}
for (const [key, count] of [...tally].sort()) console.log(`${String(count).padStart(3)}  ${key}`);

const quantile = (values: number[], q: number) => values[Math.min(values.length - 1, Math.floor(q * values.length))]!;
for (const [label, score] of [["absolute", scoreRequestAuthorityAtAbsoluteLevel], ["deviation", scoreRequestAuthority]] as const) {
  const margins = rows.map(row => replayProjection(row.field, score).scoreMargin).sort((a, b) => a - b);
  console.log(`${label} margins: min ${margins[0]!.toFixed(4)} p25 ${quantile(margins, 0.25).toFixed(4)} median ${quantile(margins, 0.5).toFixed(4)} p75 ${quantile(margins, 0.75).toFixed(4)} max ${margins[margins.length - 1]!.toFixed(4)} | below 0.12: ${margins.filter(margin => margin < 0.12).length}/${margins.length} | exactly 0: ${margins.filter(margin => margin === 0).length}`);
}
console.log(`rows where authorityDistinguishable is false: ${rows.filter(row => !replayProjection(row.field, scoreRequestAuthority).authorityDistinguishable).length}`);
