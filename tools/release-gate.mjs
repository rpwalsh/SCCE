#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const serverUrl = process.env.SCCE_LIVE_SERVER_URL ?? "http://127.0.0.1:3873";
const timeoutMs = Number(process.env.SCCE_LIVE_GATE_TIMEOUT_MS ?? 120000);
const json = process.argv.includes("--json");
const promptFile = argValue("--prompts");
const selectedIds = new Set(caseSelectionArgs());
const runSessionId = `live-gate-${Date.now().toString(36)}`;
const sessionGroupState = new Map();

const bannedAnswerSurfaces = [
  "[scce:",
  "[no_proof]",
  "[proof]",
  "scce.surface.realizer",
  "surface.verdict",
  "kernel.turn.source_anchor_miss",
  "(;",
  "|alt=",
  "|thumb",
  "[[",
  "]]",
  "==",
  "\u00ac",
  ": \"",
  "says \"",
  "Wikipedia page about",
  "source page about"
];

const defaultPromptCases = [
  {
    id: "live.ada.identity",
    prompt: "who was ada lovelace?",
    sessionGroup: "ada",
    minEvidence: 1,
    maxChars: 560,
    structural: {
      requireSelectedEvidenceBound: true,
      requireMouthRealization: true,
      requireSemanticAnswer: true,
      requireEvidenceIds: true,
      requireRuntimeCoherence: true,
      minFactCount: 1,
      maxEvidenceSourceVersions: 2,
      rejectWikiDebris: true
    }
  },
  {
    id: "live.ada.followup",
    prompt: "what was she known for?",
    sessionGroup: "ada",
    minEvidence: 1,
    maxChars: 480,
    structural: {
      requireSelectedEvidenceBound: true,
      requireMouthRealization: true,
      requireSemanticAnswer: true,
      requireEvidenceIds: true,
      requireRuntimeCoherence: true,
      requireSessionEvidenceContinuity: true,
      requireDiscourseObjectBinding: true,
      requireDiscourseEvidenceOnly: true,
      minFactCount: 1,
      maxEvidenceSourceVersions: 2,
      rejectWikiDebris: true
    }
  },
  {
    id: "live.session.new_anchor_not_carryover",
    prompt: "who was captain kirk?",
    sessionGroup: "ada",
    minEvidence: 1,
    maxChars: 520,
    structural: {
      requireSelectedEvidenceBound: true,
      requireMouthRealization: true,
      requireSemanticAnswer: true,
      requireEvidenceIds: true,
      requireRuntimeCoherence: true,
      requireSourceAnchorRequired: true,
      requireSourceAnchorMatched: true,
      rejectSessionBound: true,
      maxEvidenceSourceVersions: 2,
      rejectWikiDebris: true
    }
  },
  {
    id: "live.session.topic_not_mixed",
    prompt: "what is anarchism?",
    sessionGroup: "ada",
    minEvidence: 1,
    maxChars: 520,
    structural: {
      requireSelectedEvidenceBound: true,
      requireMouthRealization: true,
      requireSemanticAnswer: true,
      requireEvidenceIds: true,
      requireRuntimeCoherence: true,
      rejectSessionBound: true,
      requireSingleSourceVersion: true,
      minFactCount: 1,
      rejectWikiDebris: true
    }
  },
  {
    id: "live.andromeda.characters",
    prompt: "who were the characters in gene rodenberry's Andromeda?",
    minEvidence: 1,
    maxChars: 280,
    structural: {
      requireSelectedEvidenceBound: true,
      requireMouthRealization: true,
      requireSemanticAnswer: true,
      requireEvidenceIds: true,
      requireRuntimeCoherence: true,
      requireCollectionPlan: true,
      requireSingleSourceVersion: true,
      minFactCount: 4,
      rejectWikiDebris: true
    }
  },
  {
    id: "live.martha.flags",
    prompt: "did martha washington invent the concept of using flags to represent nations?",
    minEvidence: 2,
    maxChars: 560,
    structural: {
      requireSelectedEvidenceBound: true,
      requireMouthRealization: true,
      requireSemanticAnswer: true,
      requireEvidenceIds: true,
      requireRuntimeCoherence: true,
      requireTemporalCounterexample: true,
      minFactCount: 2,
      rejectWikiDebris: true
    }
  },
  {
    id: "live.multiscript.ada",
    prompt: "Ada Lovelace는 누구였나요?",
    minEvidence: 1,
    maxChars: 560,
    structural: {
      requireSelectedEvidenceBound: true,
      requireMouthRealization: true,
      requireSemanticAnswer: true,
      requireEvidenceIds: true,
      requireRuntimeCoherence: true,
      minFactCount: 1,
      maxEvidenceSourceVersions: 2,
      rejectWikiDebris: true
    }
  }
];

const ready = await getJson(`${serverUrl}/api/ready`).catch(error => ({ ok: false, error: messageOf(error) }));
if (!ready.ok) {
  console.error(`Live server is not ready at ${serverUrl}/api/ready: ${JSON.stringify(ready)}`);
  process.exit(2);
}

const cases = selectCases(await loadPromptCases());
const results = [];
for (const testCase of cases) results.push(await runCase(testCase));

const summary = {
  schema: "scce.live_release_gate.v2",
  serverUrl,
  ok: results.every(result => result.ok),
  promptCasesConfigured: cases.length,
  cases: results
};

if (json) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  process.stdout.write(`LIVE server=${serverUrl} prompts=${cases.length}\n`);
  if (!cases.length) process.stdout.write("No prompt cases configured; pass --prompts <json> or SCCE_LIVE_GATE_PROMPTS_JSON to validate live answers.\n");
  for (const result of results) {
    process.stdout.write(`${result.ok ? "PASS" : "FAIL"} ${result.id} ${Math.round(result.elapsedMs)}ms evidence=${result.evidenceCount}\n`);
    for (const failure of result.failures) process.stdout.write(`  - ${failure}\n`);
    if (!result.ok) process.stdout.write(`  answer: ${singleLine(result.answer).slice(0, 280)}\n`);
  }
}

process.exitCode = summary.ok ? 0 : 1;

async function loadPromptCases() {
  if (promptFile) return normalizePromptCases(JSON.parse(await readFile(promptFile, "utf8")));
  const fromEnv = process.env.SCCE_LIVE_GATE_PROMPTS_JSON;
  if (fromEnv) return normalizePromptCases(JSON.parse(fromEnv));
  return normalizePromptCases(defaultPromptCases);
}

function normalizePromptCases(value) {
  const rows = Array.isArray(value) ? value : [value];
  return rows.map((row, index) => {
    if (typeof row === "string") return { id: `case.${index + 1}`, prompt: row };
    const record = row && typeof row === "object" ? row : {};
    if (record.requireAll !== undefined || record.requireAny !== undefined || record.requireAtLeast !== undefined) {
      throw new Error("release gate no longer supports answer text term requirements; use structural checks instead");
    }
    const id = String(record.id ?? `case.${index + 1}`);
    const prompt = id === "live.multiscript.ada" ? "Ada Lovelace는 누구였나요?" : String(record.prompt ?? record.text ?? "");
    const promptText = id === "live.multiscript.ada" ? "Ada Lovelace는 누구였나요?" : prompt;
    return {
      id,
      prompt: promptText,
      minEvidence: numberOrUndefined(record.minEvidence),
      maxChars: numberOrUndefined(record.maxChars),
      minChars: numberOrUndefined(record.minChars),
      sessionId: optionalString(record.sessionId),
      sessionGroup: optionalString(record.sessionGroup),
      conversationId: optionalString(record.conversationId),
      rejectAny: stringArray(record.rejectAny),
      structural: normalizeStructural(record.structural)
    };
  }).filter(row => row.prompt.trim().length > 0);
}

function selectCases(cases) {
  if (!selectedIds.size) return cases;
  return cases.filter(testCase => selectedIds.has(testCase.id));
}

async function runCase(testCase) {
  const started = performance.now();
  const sessionId = testCase.sessionId ?? (testCase.sessionGroup ? `${runSessionId}-${testCase.sessionGroup}` : undefined);
  const previousGroupState = testCase.sessionGroup ? sessionGroupState.get(testCase.sessionGroup) : undefined;
  const response = await postJson(`${serverUrl}/api/turn?full=1`, {
    text: testCase.prompt,
    ...(sessionId ? { sessionId } : {}),
    ...(testCase.conversationId ? { conversationId: testCase.conversationId } : {})
  });
  const elapsedMs = performance.now() - started;
  const answer = typeof response.answer === "string" ? response.answer : "";
  const evidence = Array.isArray(response.evidence) ? response.evidence : [];
  const lowerAnswer = answer.toLocaleLowerCase();
  const failures = [];
  if (!answer.trim()) failures.push("empty answer");
  if (typeof testCase.minChars === "number" && answer.length < testCase.minChars) failures.push(`answer length ${answer.length} below ${testCase.minChars}`);
  if (typeof testCase.maxChars === "number" && answer.length > testCase.maxChars) failures.push(`answer length ${answer.length} above ${testCase.maxChars}`);
  if (typeof testCase.minEvidence === "number" && evidence.length < testCase.minEvidence) failures.push(`evidence count ${evidence.length} below ${testCase.minEvidence}`);
  for (const banned of bannedAnswerSurfaces) if (answer.includes(banned)) failures.push(`control surface appeared in answer: ${banned}`);
  for (const banned of testCase.rejectAny ?? []) if (lowerAnswer.includes(banned.toLocaleLowerCase())) failures.push(`rejected surface appeared: ${banned}`);
  const basis = response.answerBasis && typeof response.answerBasis === "object" ? response.answerBasis : undefined;
  if (basis) {
    if (basis.fakeEvidenceForbidden !== true) failures.push("answer basis does not forbid fake evidence");
    if (typeof basis.basisClassId !== "string" || !basis.basisClassId) failures.push("answer basis has no opaque basis class id");
  }
  failures.push(...structuralFailures(testCase, response, answer, evidence, previousGroupState));
  if (testCase.sessionGroup) sessionGroupState.set(testCase.sessionGroup, evidenceState(response, evidence));
  return {
    id: testCase.id,
    ok: failures.length === 0,
    elapsedMs,
    evidenceCount: evidence.length,
    failures,
    answer
  };
}

async function getJson(url) {
  const response = await fetchWithTimeout(url, { method: "GET" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function caseSelectionArgs() {
  const out = [];
  for (let index = 2; index < process.argv.length; index++) {
    const arg = process.argv[index] ?? "";
    if (arg === "--prompts") {
      index++;
      continue;
    }
    if (arg.startsWith("--")) continue;
    out.push(arg);
  }
  return out;
}

function numberOrUndefined(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === "string" && item.trim()).map(item => item.trim()) : [];
}

function normalizeStructural(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("release gate structural config must be an object");
  return {
    requireSelectedEvidenceBound: Boolean(value.requireSelectedEvidenceBound),
    requireMouthRealization: Boolean(value.requireMouthRealization),
    requireSemanticAnswer: Boolean(value.requireSemanticAnswer),
    requireEvidenceIds: Boolean(value.requireEvidenceIds),
    requireSessionEvidenceContinuity: Boolean(value.requireSessionEvidenceContinuity),
    requireCollectionPlan: Boolean(value.requireCollectionPlan),
    requireSingleSourceVersion: Boolean(value.requireSingleSourceVersion),
    requireTemporalCounterexample: Boolean(value.requireTemporalCounterexample),
    requireRuntimeCoherence: Boolean(value.requireRuntimeCoherence),
    requireDiscourseObjectBinding: Boolean(value.requireDiscourseObjectBinding),
    requireDiscourseEvidenceOnly: Boolean(value.requireDiscourseEvidenceOnly),
    requireSourceAnchorRequired: Boolean(value.requireSourceAnchorRequired),
    requireSourceAnchorMatched: Boolean(value.requireSourceAnchorMatched),
    rejectSessionBound: Boolean(value.rejectSessionBound),
    rejectWikiDebris: Boolean(value.rejectWikiDebris),
    minFactCount: numberOrUndefined(value.minFactCount),
    maxEvidenceSourceVersions: numberOrUndefined(value.maxEvidenceSourceVersions)
  };
}

function structuralFailures(testCase, response, answer, evidence, previousGroupState) {
  const structural = testCase.structural;
  if (!structural) return [];
  const failures = [];
  const selected = recordAt(response, ["entailment", "proof", "scores", "selectedEvidenceBound"]);
  const semantic = recordAt(response, ["mouth", "surfacePlan", "audit", "semanticAnswer"]);
  const runtimeCoherence = recordAt(response, ["runtimeCoherence"]);
  const discourseObject = recordAt(response, ["discourseObject"]) ?? recordAt(response, ["actionGraph", "discourseObject"]);
  if (structural.requireSelectedEvidenceBound && !selected) failures.push("missing selected evidence-bound answer object");
  if (selected) {
    if (selected.fakeEvidenceForbidden !== true) failures.push("selected answer object does not forbid fake evidence");
    if (structural.requireMouthRealization && selected.mouthRealizationRequired !== true) failures.push("selected answer object does not require mouth realization");
    if (structural.requireEvidenceIds && selectedAnswerEvidenceIds(selected).length < Math.max(1, testCase.minEvidence ?? 1)) failures.push("selected answer object has too few evidence ids");
    if (structural.requireSourceAnchorRequired && selected.sourceAnchorRequired !== true) failures.push("selected answer object did not require a source anchor");
    if (structural.requireSourceAnchorMatched && selected.sourceAnchorMatched !== true) failures.push("selected answer object did not match a source anchor");
    if (structural.rejectSessionBound && selected.sessionBound === true) failures.push("selected answer object was session-bound for a new topic");
    if (typeof selected.answerKindId === "string" && !looksOpaqueId(selected.answerKindId)) failures.push("selected answer kind id is not opaque");
    if (typeof selected.answerPlanId === "string" && !looksOpaqueId(selected.answerPlanId)) failures.push("selected answer plan id is not opaque");
  }
  if (structural.requireSemanticAnswer && !semantic) failures.push("missing mouth semantic-answer audit");
  if (semantic) {
    if (typeof semantic.factCount !== "number" || semantic.factCount < (structural.minFactCount ?? 1)) failures.push(`semantic fact count below ${structural.minFactCount ?? 1}`);
    if (stringArray(semantic.supportIds).length < Math.max(1, testCase.minEvidence ?? 1)) failures.push("semantic answer has too few support ids");
    const boundary = semantic.certificationBoundary && typeof semantic.certificationBoundary === "object" ? semantic.certificationBoundary : undefined;
    if (!boundary) failures.push("semantic answer missing certification boundary");
    if (boundary && stringArray(boundary.evidenceSpanIds).length < Math.max(1, testCase.minEvidence ?? 1)) failures.push("semantic certification boundary has too few evidence spans");
  }
  const sourceVersionIds = sourceVersionIdsForResponse(response, evidence);
  if (typeof structural.maxEvidenceSourceVersions === "number" && sourceVersionIds.length > structural.maxEvidenceSourceVersions) failures.push(`evidence source versions ${sourceVersionIds.length} above ${structural.maxEvidenceSourceVersions}`);
  if (structural.requireSingleSourceVersion && sourceVersionIds.length !== 1) failures.push(`expected one evidence source version, got ${sourceVersionIds.length}`);
  if (structural.requireCollectionPlan && selected) {
    if (typeof selected.listRichRows !== "number" || selected.listRichRows < 1) failures.push("collection answer lacks source-derived list rows");
    if (typeof selected.sourceDerivedRows !== "number" || selected.sourceDerivedRows < 1) failures.push("collection answer lacks source-derived row count");
  }
  if (structural.requireTemporalCounterexample && selected) {
    const birthYear = Number(selected.birthYear);
    const counterexampleYear = Number(selected.counterexampleYear);
    if (!Number.isFinite(birthYear) || !Number.isFinite(counterexampleYear)) failures.push("temporal counterexample lacks numeric years");
    if (Number.isFinite(birthYear) && Number.isFinite(counterexampleYear) && !(counterexampleYear < birthYear)) failures.push("temporal counterexample does not predate subject");
    if (Number.isFinite(counterexampleYear) && counterexampleYear > 0 && counterexampleYear < 700) failures.push("temporal counterexample year looks like a document number");
    if (/[$€£¥₩₹₽¢]/u.test(answer)) failures.push("temporal counterexample answer contains currency marker");
    if (typeof selected.subjectEvidenceId !== "string" || !selected.subjectEvidenceId) failures.push("temporal counterexample lacks subject evidence id");
    if (typeof selected.counterexampleEvidenceId !== "string" || !selected.counterexampleEvidenceId) failures.push("temporal counterexample lacks counterexample evidence id");
    if (typeof selected.polarityId === "string" && !looksOpaqueId(selected.polarityId)) failures.push("temporal counterexample polarity id is not opaque");
  }
  if (structural.requireRuntimeCoherence) {
    if (!runtimeCoherence) {
      failures.push("missing runtime coherence decision");
    } else {
      if (runtimeCoherence.schema !== "scce.runtime_coherence_decision.v1") failures.push("runtime coherence decision schema mismatch");
      if (typeof runtimeCoherence.coherenceMass !== "number" || typeof runtimeCoherence.instabilityMass !== "number") failures.push("runtime coherence missing mass values");
      if (!Array.isArray(runtimeCoherence.failedDimensionIds) || !Array.isArray(runtimeCoherence.repairTargetIds)) failures.push("runtime coherence missing structural ids");
      if (typeof runtimeCoherence.assistantForceAfter === "string" && response.assistantForce !== runtimeCoherence.assistantForceAfter) failures.push("runtime coherence did not control assistant force");
      if (typeof runtimeCoherence.assistantForceAfter === "string" && runtimeCoherence.assistantForceAfter === "learned_corpus_answer" && evidence.length === 0) failures.push("runtime coherence allowed learned prior without evidence");
    }
  }
  if (structural.requireSessionEvidenceContinuity) {
    const evidenceIds = evidence.map(item => item?.id).filter(Boolean);
    if (!previousGroupState) {
      failures.push("session continuity requested before prior group turn");
    } else if (!hasOverlap(previousGroupState.sourceVersionIds, sourceVersionIds) && !hasOverlap(previousGroupState.evidenceIds, evidenceIds)) {
      failures.push("follow-up turn did not retain evidence/session continuity");
    }
  }
  if (structural.requireDiscourseObjectBinding) {
    if (!discourseObject) {
      failures.push("missing discourse object binding");
    } else {
      if (discourseObject.schema !== "scce.discourse_object_state.v1") failures.push("discourse object schema mismatch");
      if (typeof discourseObject.objectId !== "string" || !looksOpaqueId(discourseObject.objectId)) failures.push("discourse object id is not opaque");
      if (typeof discourseObject.stateId !== "string" || !looksOpaqueId(discourseObject.stateId)) failures.push("discourse state id is not opaque");
      if (typeof discourseObject.bindingConfidence !== "number" || discourseObject.bindingConfidence < 0.45) failures.push("discourse binding confidence below threshold");
      if (discourseObject.queryConcatenationUsed !== false) failures.push("discourse binding used query concatenation");
      const discourseEvidenceIds = stringArray(discourseObject.evidenceIds);
      if (!discourseEvidenceIds.length) failures.push("discourse object has no evidence ids");
      if (previousGroupState && !hasOverlap(previousGroupState.evidenceIds, discourseEvidenceIds)) failures.push("discourse object evidence does not overlap prior evidence state");
      for (const signalId of stringArray(discourseObject.signalIds)) if (!/^disc\.signal\.[0-9a-f]{8}$/u.test(signalId)) failures.push(`discourse signal id is not opaque: ${signalId}`);
      if (typeof discourseObject.policyId === "string" && !/^disc\.policy\.[0-9a-f]{8}$/u.test(discourseObject.policyId)) failures.push("discourse policy id is not opaque");
    }
  }
  if (structural.requireDiscourseEvidenceOnly) {
    if (!discourseObject) {
      failures.push("discourse evidence containment requested without discourse object");
    } else {
      const allowedSourceVersionIds = new Set(stringArray(discourseObject.sourceVersionIds));
      const outside = sourceVersionIds.filter(id => !allowedSourceVersionIds.has(id));
      if (outside.length) failures.push(`follow-up evidence escaped discourse object: ${outside.slice(0, 4).join(",")}`);
    }
  }
  if (structural.rejectWikiDebris && /(\[\[|\]\]|\|alt=|\|thumb|={2,}|File:|Image:)/u.test(answer)) failures.push("wiki markup debris appeared in answer");
  return failures;
}

function evidenceState(response, evidence) {
  const selected = recordAt(response, ["entailment", "proof", "scores", "selectedEvidenceBound"]);
  return {
    evidenceIds: [...new Set([
      ...evidence.map(item => item?.id).filter(Boolean),
      ...selectedAnswerEvidenceIds(selected)
    ])],
    sourceVersionIds: sourceVersionIdsForResponse(response, evidence)
  };
}

function sourceVersionIdsForResponse(response, evidence) {
  const selected = recordAt(response, ["entailment", "proof", "scores", "selectedEvidenceBound"]);
  const selectedIds = new Set(selectedAnswerEvidenceIds(selected));
  const selectedEvidence = selectedIds.size
    ? evidence.filter(item => selectedIds.has(String(item?.id ?? "")))
    : evidence;
  return uniqueStrings(selectedEvidence.map(item => typeof item?.sourceVersionId === "string" ? item.sourceVersionId : undefined));
}

function recordAt(value, path) {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = current[key];
  }
  return current && typeof current === "object" && !Array.isArray(current) ? current : undefined;
}

function selectedAnswerEvidenceIds(selected) {
  if (!selected) return [];
  return uniqueStrings([
    ...stringArray(selected.evidenceIds),
    ...Object.entries(selected)
      .filter(([key, value]) => key.endsWith("EvidenceId") && typeof value === "string")
      .map(([, value]) => value)
  ]);
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === "string" && value.trim()).map(value => value.trim()))];
}

function looksOpaqueId(value) {
  return /^[a-z_]+(?:\.[a-z_]+)*[._][0-9a-f]{6,}$/u.test(value) || /^[a-z_]+_[0-9a-f]{24,}$/u.test(value);
}

function hasOverlap(left, right) {
  const rightSet = new Set(right);
  return left.some(item => rightSet.has(item));
}

function singleLine(text) {
  return text.replace(/\s+/gu, " ").trim();
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
