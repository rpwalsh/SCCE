#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Reads a recorded trace offline and prints one stage-per-line block per turn. No server, no model, no authored text.
import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

export const TURN_TRANSCRIPT_SCHEMA = "scce.turn_transcript.v1";

export const STAGE_IDS = ["population", "candidates", "authority", "planning", "realization", "withheld", "surface"];

/** The five stages a comparison has to be able to blame, in the order a turn traverses them. */
export const FAILURE_STAGE_ORDER = ["population", "candidates", "authority", "planning", "realization"];

export const STAGE_STATUS = { ok: "stage.ok", empty: "stage.empty", missing: "stage.missing" };
export const FAILURE_IDS = {
  none: "failure.none",
  population: "failure.population",
  candidates: "failure.construction",
  authority: "failure.authority",
  planning: "failure.planning",
  realization: "failure.realization"
};
export const OUTCOME_IDS = { answered: "outcome.answered", withheld: "outcome.withheld", error: "outcome.error" };
export const PROBE_MATCH_IDS = { text: "probe.by_request_text", ordinal: "probe.by_ordinal", none: "probe.unmatched" };

const num = value => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = value => (typeof value === "string" && value.length ? value : null);
const rec = value => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const arr = value => (Array.isArray(value) ? value : []);

/** Group a flat event stream into turns. A turn opens at turn.input and closes at the next one. */
export function segmentTurns(events) {
  const turns = [];
  let current = null;
  for (const event of events) {
    if (event.stage === "turn.input") {
      current = { index: turns.length + 1, events: [] };
      turns.push(current);
    }
    if (current) current.events.push(event);
  }
  return turns;
}

function pick(events, stage, label) {
  const hits = events.filter(event => event.stage === stage && (label === undefined || event.label === label));
  return { first: hits[0], last: hits[hits.length - 1], all: hits, count: hits.length };
}

function statusFor(present, populated) {
  if (!present) return STAGE_STATUS.missing;
  return populated ? STAGE_STATUS.ok : STAGE_STATUS.empty;
}

function populationStage(events) {
  const identity = pick(events, "runtime.seed.language_identity", "kernel.turn").first;
  const seed = pick(events, "runtime.seed.language", "kernel.turn").first;
  const role = pick(events, "runtime.candidates.language_role", "kernel.turn").last;
  const hydrate = pick(events, "candidate.language.hydrate", "kernel.turn").last;
  const cache = pick(events, "language.cache.lookup").last;
  const present = Boolean(identity || seed || role || hydrate);
  const models = num(rec(hydrate?.counts).models) ?? num(rec(role?.counts).models) ?? num(rec(seed?.counts).models);
  return {
    status: statusFor(present, (models ?? 0) > 0),
    languageId: str(rec(identity?.support).languageId) ?? str(rec(role?.support).languageId),
    script: str(rec(identity?.support).script),
    identities: num(rec(identity?.counts).identities),
    coverage: num(rec(identity?.counts).coverage),
    cacheResult: str(rec(cache?.support).result),
    cacheReason: str(rec(cache?.support).reason),
    clusterId: str(rec(cache?.support).cluster),
    roleId: str(rec(role?.support).role) ?? str(rec(hydrate?.support).corpusRole),
    scopeId: str(rec(role?.support).scope),
    speaks: rec(role?.support).speaks ?? null,
    ready: rec(role?.support).ready ?? null,
    models,
    patterns: num(rec(hydrate?.counts).patterns) ?? num(rec(seed?.counts).patterns),
    units: num(rec(hydrate?.counts).units) ?? num(rec(role?.counts).units),
    bundles: num(rec(role?.counts).bundles),
    scopeProfiles: num(rec(role?.counts).scopeProfiles),
    semanticFrames: num(rec(hydrate?.counts).semanticFrames) ?? num(rec(seed?.counts).semanticFrames)
  };
}

function candidatesStage(events) {
  const proposals = pick(events, "candidate.proposal").all;
  const quotation = pick(events, "candidate.proposal.quotation_recall").all;
  const score = pick(events, "candidate.score", "kernel.turn").last;
  const field = pick(events, "candidate.field.generate", "kernel.turn").last;
  const invention = pick(events, "candidate.invention.plan", "kernel.turn").last;
  const mouthSelect = pick(events, "mouth.candidate.select", "mouth.speak").last;
  const admit = pick(events, "mouth.learned_construction.admit", "mouth.speak").last;
  const reject = pick(events, "mouth.learned_construction.reject", "mouth.speak").last;
  const contract = pick(events, "candidate.realization_contract", "kernel.turn").last;
  const scored = arr(rec(score?.support).candidates);
  const surfaces = arr(rec(mouthSelect?.support).candidates);
  const present = Boolean(score || proposals.length || field || mouthSelect);
  return {
    status: statusFor(present, scored.length > 0 || surfaces.length > 0),
    // Producer ids are the trace labels the proposals were emitted under.
    producerIds: [...new Set(proposals.map(event => str(event.label)).filter(Boolean))],
    proposed: proposals.reduce((sum, event) => sum + (num(rec(event.counts).proposed) ?? 0), 0),
    quotationRecall: quotation.length,
    fieldGenerated: num(rec(field?.counts).candidates),
    inventions: num(rec(invention?.counts).candidates),
    scored: scored.length,
    kindIds: [...new Set(scored.map(row => str(row.kind)).filter(Boolean))],
    candidateIds: scored.map(row => str(row.id)).filter(Boolean),
    surfaceCandidates: surfaces.length,
    surfaceValid: surfaces.filter(row => row.valid === true).length,
    surfaceViolationIds: [...new Set(surfaces.flatMap(row => arr(row.hardViolations).map(v => str(v.id)).filter(Boolean)))],
    constructionId: str(rec(admit?.support).constructionId),
    constructionBundleId: str(rec(admit?.support).bundleId),
    constructionFit: num(rec(admit?.support).fit),
    constructionRejectReasonId: str(rec(reject?.support).reason),
    contractSourceId: str(rec(contract?.support).contractSource),
    requiredAtoms: num(rec(contract?.counts).requiredAtoms),
    requiredRelationUnits: num(rec(contract?.counts).requiredRelationUnits)
  };
}

function authorityStage(events) {
  const projection = pick(events, "turn.authority.projection", "kernel.turn").first;
  const score = pick(events, "candidate.score", "kernel.turn").last;
  const basis = pick(events, "candidate.score", "kernel.turn.basis_answer").last;
  const attach = pick(events, "proof.attach", "kernel.turn").last;
  const admission = rec(rec(rec(score?.support).authorityAdmission).authorityAdmission);
  const audit = rec(rec(basis?.support).audit);
  const admitted = arr(admission.admittedCandidateIds).map(String);
  const present = Boolean(projection || score);
  return {
    status: statusFor(present, admitted.length > 0),
    requestedAuthority: str(rec(projection?.support).requestedAuthority),
    projectedAuthority: str(rec(projection?.support).projectedAuthority),
    projectionMargin: num(rec(projection?.support).scoreMargin),
    explicit: rec(projection?.support).explicit ?? null,
    admittedCandidateIds: admitted,
    admittedKindIds: arr(admission.admittedCandidateKinds).map(String),
    rejected: arr(admission.rejectedFactualProofCandidates).map(row => ({
      candidateId: str(row.candidateId),
      failureIds: arr(row.failures).map(String)
    })),
    authorityUnavailable: admission.authorityUnavailable ?? null,
    fallbackToGeneratedField: admission.fallbackToGeneratedField ?? null,
    admissionSourceId: str(admission.source),
    // Per-commitment basis: which class certified the answer and off which evidence.
    basisClassId: str(audit.basisClassId),
    certificationId: str(audit.certificationId),
    verifierVerdictId: str(audit.certificationVerifierVerdict),
    entailmentForceId: str(audit.entailmentForce) ?? str(rec(attach?.support).force),
    evidenceBound: audit.evidenceBound ?? null,
    evidenceCount: num(audit.evidenceCount) ?? num(rec(attach?.counts).evidenceIds),
    contradiction: num(audit.contradiction),
    proofId: str(rec(attach?.support).proofId),
    faithfulnessLcb: num(rec(attach?.support).faithfulnessLcb)
  };
}

function planningStage(events) {
  const select = pick(events, "planner.select", "kernel.turn").last;
  const score = pick(events, "candidate.score", "kernel.turn").last;
  const selectedId = str(rec(select?.support).candidateId);
  const masses = arr(rec(score?.support).surfaceMass);
  const operators = arr(rec(rec(score?.support).authorityAdmission).candidateOperators);
  const mine = masses.find(row => String(row.candidateId) === selectedId);
  const myOperator = operators.find(row => String(row.candidateId) === selectedId);
  const others = operators.filter(row => String(row.candidateId) !== selectedId);
  const bestOther = others.reduce((best, row) => {
    const p = num(row.boltzmannProbability);
    return p !== null && (best === null || p > best) ? p : best;
  }, null);
  const myP = num(myOperator?.boltzmannProbability);
  return {
    status: statusFor(Boolean(select), Boolean(selectedId)),
    selectedCandidateId: selectedId,
    kindId: str(rec(select?.support).kind),
    forceId: str(rec(select?.support).force),
    assistantForceId: str(rec(select?.support).assistantForce),
    rejectedCount: num(rec(select?.counts).rejected),
    surfaceMass: num(mine?.mass),
    surfaceRawMass: num(mine?.rawMass),
    calibrated: mine?.calibrated ?? null,
    calibrationId: str(mine?.calibrationId),
    freeEnergy: num(myOperator?.freeEnergy),
    leastActionCost: num(myOperator?.leastActionCost),
    leastActionReachable: myOperator?.leastActionReachable ?? null,
    boltzmannProbability: myP,
    // Derived by joining traced boltzmannProbability values; not a new quantity.
    boltzmannMarginToRunnerUp: myP !== null && bestOther !== null ? myP - bestOther : null,
    operatorCount: operators.length
  };
}

function realizationStage(events) {
  const decision = pick(events, "mouth.realize.decision", "kernel.turn").last;
  const deterministic = pick(events, "mouth.deterministic.select", "mouth.speak").last;
  const generate = pick(events, "mouth.generate", "kernel.turn").last;
  const chars = num(rec(generate?.counts).answerChars);
  const fallbackIds = [
    "mouth.source_summary_fallback",
    "mouth.source_summary_fallback.withheld",
    "mouth.contradiction_fallback",
    "mouth.contradiction_fallback.rejected_subject_only",
    "mouth.deterministic_fallback",
    "turn.output.prompt_echo_refused"
  ].filter(stage => events.some(event => event.stage === stage));
  return {
    status: statusFor(Boolean(generate || deterministic || decision), (chars ?? 0) > 0),
    learnedMouthAllowed: rec(decision?.support).learnedMouthAllowed ?? null,
    deadlineWouldRefuse: rec(decision?.support).deadlineWouldRefuse ?? null,
    deadlineReasonId: str(rec(rec(decision?.support).decision).reason),
    hasSemanticConstruct: rec(decision?.support).hasSemanticConstruct ?? null,
    deterministicSurfaces: num(rec(deterministic?.counts).surfaces),
    deterministicChosenChars: num(rec(deterministic?.counts).chosenChars),
    deterministicUnits: num(rec(deterministic?.counts).units),
    answerChars: chars,
    evidenceRefs: num(rec(generate?.counts).evidenceRefs),
    selectedCandidateId: str(rec(generate?.support).selectedCandidateId),
    surfaceRealizationId: str(rec(generate?.support).surfaceRealizationId),
    semanticPlanId: str(rec(generate?.support).semanticPlanId),
    forceId: str(rec(generate?.support).force),
    assistantForceId: str(rec(generate?.support).assistantForce),
    learnedMouthAdmitted: rec(generate?.support).learnedMouthAdmitted ?? null,
    fallbackStageIds: fallbackIds
  };
}

function withheldStage(events) {
  const typed = pick(events, "turn.withheld", "api.turn").last;
  const summaryWithheld = pick(events, "mouth.source_summary_fallback.withheld", "kernel.turn").last;
  const error = pick(events, "turn.error").last;
  const support = rec(typed?.support);
  const present = Boolean(typed || summaryWithheld || error);
  return {
    status: present ? (str(support.reasonId) || summaryWithheld || error ? STAGE_STATUS.ok : STAGE_STATUS.empty) : STAGE_STATUS.missing,
    reasonId: str(support.reasonId),
    basisReasonIds: arr(support.basisReasonIds).map(String),
    truthStateId: str(support.truthStateId),
    entailmentVerdictId: str(support.entailmentVerdict),
    epistemicForceId: str(support.epistemicForce),
    requestedAuthority: str(support.requestedAuthority),
    unresolvedRequirementIds: arr(support.unresolvedRequirementIds).map(String),
    learningNeedIds: arr(support.learningNeedIds).map(String),
    componentStatuses: arr(support.components).map(row => `${str(row.id)}=${str(row.status)}`),
    summaryWithheldReasonId: str(rec(summaryWithheld?.support).reason),
    errorWarnings: arr(error?.warnings).map(String),
    errorDurationMs: num(error?.durationMs)
  };
}

function surfaceStage(events) {
  const api = pick(events, "turn.output", "api.turn").last;
  const kernel = pick(events, "turn.output", "kernel.turn").last;
  const deadline = pick(events, "turn.deadline.observed", "api.turn").last;
  const emitted = api ?? kernel;
  const timing = rec(rec(kernel?.support).timing);
  return {
    status: statusFor(Boolean(emitted), (num(rec(emitted?.counts).answerChars) ?? 0) > 0),
    text: str(emitted?.output),
    answerChars: num(rec(emitted?.counts).answerChars),
    evidence: num(rec(emitted?.counts).evidence),
    episodeId: str(rec(kernel?.support).episodeId),
    totalMs: num(timing.totalMs) ?? num(kernel?.durationMs),
    budgetExceededIds: arr(rec(kernel?.support).budgetExceeded).map(String),
    deadlineStatusId: str(rec(deadline?.support).status),
    outputSourceId: str(rec(deadline?.support).outputSource),
    elapsedMs: num(rec(deadline?.support).elapsedMs)
  };
}

function classify(stages) {
  if (stages.surface.status === STAGE_STATUS.ok) return FAILURE_IDS.none;
  for (const id of FAILURE_STAGE_ORDER) {
    if (stages[id].status !== STAGE_STATUS.ok) return FAILURE_IDS[id];
  }
  return FAILURE_IDS.realization;
}

function outcomeFor(stages) {
  if (stages.surface.status === STAGE_STATUS.ok) return OUTCOME_IDS.answered;
  if (stages.withheld.errorWarnings.length || stages.withheld.reasonId) return OUTCOME_IDS.withheld;
  return OUTCOME_IDS.error;
}

/** One typed record per turn. Every field is read off traced events; nothing is re-derived from text. */
export function turnRecord(turn) {
  const input = turn.events.find(event => event.stage === "turn.input");
  const stages = {
    population: populationStage(turn.events),
    candidates: candidatesStage(turn.events),
    authority: authorityStage(turn.events),
    planning: planningStage(turn.events),
    realization: realizationStage(turn.events),
    withheld: withheldStage(turn.events),
    surface: surfaceStage(turn.events)
  };
  const missingStageIds = STAGE_IDS.filter(id => stages[id].status === STAGE_STATUS.missing);
  return {
    index: turn.index,
    traceId: str(input?.traceId),
    time: str(input?.time),
    episodeId: stages.surface.episodeId,
    requestText: str(input?.input),
    requestChars: num(rec(input?.counts).textChars),
    eventCount: turn.events.length,
    stageStatus: Object.fromEntries(STAGE_IDS.map(id => [id, stages[id].status])),
    missingStageIds,
    outcome: outcomeFor(stages),
    failureClass: classify(stages),
    stages
  };
}

export function readTraceEvents(filePath) {
  return new Promise((resolve, reject) => {
    const events = [];
    const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
    rl.on("line", line => {
      if (!line.trim()) return;
      try { events.push(JSON.parse(line)); } catch { /* a partial final line is not an event */ }
    });
    rl.on("close", () => resolve(events));
    rl.on("error", reject);
  });
}

export function attachProbe(records, probe) {
  const rows = arr(rec(probe).rows);
  if (!rows.length) return records;
  const byText = new Map();
  for (const [i, row] of rows.entries()) if (str(row.text)) byText.set(String(row.text), { row, i });
  let ordinal = 0;
  return records.map(record => {
    const exact = record.requestText !== null && record.requestChars === record.requestText.length
      ? byText.get(record.requestText)
      : undefined;
    const hit = exact ?? (ordinal < rows.length ? { row: rows[ordinal], i: ordinal } : undefined);
    if (hit) ordinal = hit.i + 1;
    return {
      ...record,
      probe: hit
        ? {
          matchId: exact ? PROBE_MATCH_IDS.text : PROBE_MATCH_IDS.ordinal,
          rowIndex: hit.i,
          elapsedMs: num(hit.row.elapsedMs),
          evidence: num(hit.row.evidence),
          answerChars: typeof hit.row.answer === "string" ? hit.row.answer.length : null,
          answerCharsAgree: typeof hit.row.answer === "string" && record.stages.surface.answerChars !== null
            ? hit.row.answer.length === record.stages.surface.answerChars
            : null
        }
        : { matchId: PROBE_MATCH_IDS.none }
    };
  });
}

const fmt = value => {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(4);
  if (Array.isArray(value)) return value.length ? value.join(",") : "-";
  return String(value);
};
const shortId = value => (typeof value === "string" && value.length > 44 ? `${value.slice(0, 41)}…` : fmt(value));
const oneLine = value => (typeof value === "string" ? JSON.stringify(value.replace(/\s+/gu, " ").slice(0, 220)) : "-");
const kv = pairs => pairs.map(([k, v]) => `${k}=${v}`).join(" ");

export function renderTurn(record) {
  const s = record.stages;
  const row = (id, status, pairs) => `  ${id.padEnd(12)}${status.replace("stage.", "").padEnd(9)}${kv(pairs)}`;
  const lines = [];
  lines.push(`turn ${String(record.index).padStart(4, "0")} ${kv([
    ["episode", shortId(record.episodeId)],
    ["t", fmt(record.time)],
    ["events", fmt(record.eventCount)],
    ["outcome", record.outcome],
    ["failure", record.failureClass],
    ...(record.missingStageIds.length ? [["missingStages", record.missingStageIds.join(",")]] : []),
    ...(record.probe ? [["probe", record.probe.matchId], ["probeMs", fmt(record.probe.elapsedMs)], ["probeAgree", fmt(record.probe.answerCharsAgree)]] : [])
  ])}`);
  lines.push(`  request     ${fmt(record.requestChars)}c ${oneLine(record.requestText)}`);
  lines.push(row("population", s.population.status, [
    ["lang", shortId(s.population.languageId)], ["script", fmt(s.population.script)],
    ["ids", fmt(s.population.identities)], ["cov", fmt(s.population.coverage)],
    ["cache", `${fmt(s.population.cacheResult)}/${fmt(s.population.cacheReason)}`],
    ["role", shortId(s.population.roleId)], ["scope", fmt(s.population.scopeId)],
    ["speaks", fmt(s.population.speaks)], ["ready", fmt(s.population.ready)],
    ["models", fmt(s.population.models)], ["patterns", fmt(s.population.patterns)],
    ["units", fmt(s.population.units)], ["bundles", fmt(s.population.bundles)],
    ["scopeProfiles", fmt(s.population.scopeProfiles)]
  ]));
  lines.push(row("candidates", s.candidates.status, [
    ["producers", fmt(s.candidates.producerIds)], ["proposed", fmt(s.candidates.proposed)],
    ["quote", fmt(s.candidates.quotationRecall)], ["field", fmt(s.candidates.fieldGenerated)],
    ["invent", fmt(s.candidates.inventions)], ["scored", fmt(s.candidates.scored)],
    ["kinds", fmt(s.candidates.kindIds)],
    ["surf", `${fmt(s.candidates.surfaceValid)}/${fmt(s.candidates.surfaceCandidates)}`],
    ["surfReject", fmt(s.candidates.surfaceViolationIds)],
    ["construction", shortId(s.candidates.constructionId)], ["fit", fmt(s.candidates.constructionFit)],
    ["constrReject", fmt(s.candidates.constructionRejectReasonId)],
    ["contract", fmt(s.candidates.contractSourceId)],
    ["reqAtoms", fmt(s.candidates.requiredAtoms)], ["reqRelUnits", fmt(s.candidates.requiredRelationUnits)]
  ]));
  lines.push(row("authority", s.authority.status, [
    ["req", fmt(s.authority.requestedAuthority)], ["proj", fmt(s.authority.projectedAuthority)],
    ["projMargin", fmt(s.authority.projectionMargin)],
    ["admitted", fmt(s.authority.admittedCandidateIds.length)], ["admittedKinds", fmt(s.authority.admittedKindIds)],
    ["rejected", fmt(s.authority.rejected.length)],
    ["rejectFailures", fmt([...new Set(s.authority.rejected.flatMap(r => r.failureIds))])],
    ["unavailable", fmt(s.authority.authorityUnavailable)], ["fieldFallback", fmt(s.authority.fallbackToGeneratedField)],
    ["basis", fmt(s.authority.basisClassId)], ["cert", fmt(s.authority.certificationId)],
    ["verdict", fmt(s.authority.verifierVerdictId)], ["entForce", fmt(s.authority.entailmentForceId)],
    ["evBound", fmt(s.authority.evidenceBound)], ["ev", fmt(s.authority.evidenceCount)],
    ["contra", fmt(s.authority.contradiction)], ["faithLcb", fmt(s.authority.faithfulnessLcb)]
  ]));
  lines.push(row("planning", s.planning.status, [
    ["selected", shortId(s.planning.selectedCandidateId)], ["kind", fmt(s.planning.kindId)],
    ["force", fmt(s.planning.forceId)], ["aForce", fmt(s.planning.assistantForceId)],
    ["rejected", fmt(s.planning.rejectedCount)],
    ["mass", fmt(s.planning.surfaceMass)], ["rawMass", fmt(s.planning.surfaceRawMass)],
    ["calib", fmt(s.planning.calibrationId)], ["F", fmt(s.planning.freeEnergy)],
    ["P", fmt(s.planning.boltzmannProbability)], ["Pmargin", fmt(s.planning.boltzmannMarginToRunnerUp)],
    ["operators", fmt(s.planning.operatorCount)]
  ]));
  lines.push(row("realization", s.realization.status, [
    ["learnedAllowed", fmt(s.realization.learnedMouthAllowed)],
    ["deadlineRefuse", fmt(s.realization.deadlineWouldRefuse)],
    ["deadlineReason", fmt(s.realization.deadlineReasonId)],
    ["semConstruct", fmt(s.realization.hasSemanticConstruct)],
    ["detSurfaces", fmt(s.realization.deterministicSurfaces)], ["detChars", fmt(s.realization.deterministicChosenChars)],
    ["chars", fmt(s.realization.answerChars)], ["evRefs", fmt(s.realization.evidenceRefs)],
    ["surfaceRealization", shortId(s.realization.surfaceRealizationId)],
    ["learnedAdmitted", fmt(s.realization.learnedMouthAdmitted)],
    ["fallbacks", fmt(s.realization.fallbackStageIds)]
  ]));
  lines.push(row("withheld", s.withheld.status, [
    ["reason", fmt(s.withheld.reasonId)], ["basisReasons", fmt(s.withheld.basisReasonIds)],
    ["truthState", fmt(s.withheld.truthStateId)], ["entVerdict", fmt(s.withheld.entailmentVerdictId)],
    ["epForce", fmt(s.withheld.epistemicForceId)],
    ["unresolved", fmt(s.withheld.unresolvedRequirementIds)], ["needs", fmt(s.withheld.learningNeedIds)],
    ["components", fmt(s.withheld.componentStatuses)],
    ["summaryWithheld", fmt(s.withheld.summaryWithheldReasonId)],
    ["errorWarnings", fmt(s.withheld.errorWarnings.map(oneLine))]
  ]));
  lines.push(row("surface", s.surface.status, [
    ["chars", fmt(s.surface.answerChars)], ["ev", fmt(s.surface.evidence)],
    ["totalMs", fmt(s.surface.totalMs)], ["deadline", fmt(s.surface.deadlineStatusId)],
    ["outputSource", fmt(s.surface.outputSourceId)], ["budgetExceeded", fmt(s.surface.budgetExceededIds)]
  ]));
  lines.push(`  text        ${oneLine(s.surface.text)}`);
  return lines.join("\n");
}

async function main(argv) {
  const positional = argv.filter(a => !a.startsWith("--"));
  const flag = name => {
    const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return undefined;
    return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
  };
  const tracePath = positional[0];
  if (!tracePath) {
    process.stdout.write("turn-transcript <trace.jsonl> [--probe=<probe.json>] [--json] [--limit=N] [--turn=N,N] [--failure=<id>] [--outcome=<id>] [--index]\n");
    process.exitCode = 2;
    return;
  }
  const events = await readTraceEvents(tracePath);
  let records = segmentTurns(events).map(turnRecord);
  const probePath = flag("probe");
  if (probePath) records = attachProbe(records, JSON.parse(readFileSync(probePath, "utf8")));

  const turnFilter = flag("turn");
  if (turnFilter) {
    const wanted = new Set(turnFilter.split(",").map(Number));
    records = records.filter(r => wanted.has(r.index));
  }
  const failure = flag("failure");
  if (failure) records = records.filter(r => r.failureClass === failure);
  const outcome = flag("outcome");
  if (outcome) records = records.filter(r => r.outcome === outcome);
  const limit = flag("limit");
  if (limit) records = records.slice(0, Number(limit));

  if (flag("json") !== undefined) {
    process.stdout.write(`${JSON.stringify({ schema: TURN_TRANSCRIPT_SCHEMA, traceFile: tracePath, turns: records.length, records }, null, 2)}\n`);
    return;
  }
  if (flag("index") !== undefined) {
    for (const r of records) {
      process.stdout.write(`${String(r.index).padStart(4, "0")} ${r.outcome.padEnd(17)} ${r.failureClass.padEnd(22)} chars=${fmt(r.stages.surface.answerChars)} models=${fmt(r.stages.population.models)} scored=${fmt(r.stages.candidates.scored)} admitted=${r.stages.authority.admittedCandidateIds.length} ${oneLine(r.requestText)}\n`);
    }
    return;
  }
  for (const r of records) process.stdout.write(`${renderTurn(r)}\n\n`);
}

if (String(process.argv[1] ?? "").split(/[\\/]/u).pop() === "turn-transcript.mjs") {
  await main(process.argv.slice(2));
}
