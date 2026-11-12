// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Read-only diagnostic: force one observed request-surface cohort through the durable construction compiler,
// leave-one-document-out request recovery, and the request-only omitted-slot audit. This is deliberately not
// imported by a production package and never publishes patterns or writes storage.
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPostgresStorageAdapter,
  readScceRuntimeConfig
} from "../packages/adapters-node/dist/index.js";
import { readSourceTranscriptArchive } from "../packages/adapters-node/dist/source-transcript-archive.js";
import { copiedRequestRoleSpans } from "../packages/kernel/dist/conversational-frame-walk.js";
import { surfaceSentenceRanges } from "../packages/kernel/dist/surface-linguistics.js";
import {
  SOURCE_EXAMPLE_CONSTRUCTION_STORAGE,
  acquireContextualQaConstructions,
  canonicalStringify,
  compileLanguageConstructionPattern,
  createHasher,
  hydrateLanguageConstructionPatterns,
  inspectContextualQaLiteralAnswerAlignment,
  inspectLearnedRequestOmittedSlot,
  sourceConstructionRequestValueResolver
} from "../packages/kernel/dist/index.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DOLLY_URI_PREFIX = "file:///C:/Users/react/scce/.scce/corpus-bootstrap/dolly15k-v1/";

export async function runContextualQaSecondOrderProbe(options) {
  const hasher = createHasher();
  const config = await readScceRuntimeConfig(options.configPath);
  const storage = createPostgresStorageAdapter({ ...config.database, informationAccess: config.security?.informationAccess });
  try {
    const corpus = await loadMatchingDollyPairs(storage, [options.requestPrefix, options.secondaryPrefix]);
    const selected = corpus.matching.filter(row => row.request.surface.normalize("NFC").startsWith(options.requestPrefix.normalize("NFC")));
    if (selected.length !== options.expectedExamples) {
      throw new Error(`Expected ${options.expectedExamples} retained requests with the supplied prefix; found ${selected.length}`);
    }
    const requests = selected.map(row => row.request.surface.normalize("NFC"));
    const residue = longestCommonCodePointPrefix(requests);
    if (!residue || requests.some(request => [...request].length <= [...residue].length)) {
      throw new Error("Selected requests do not have a non-empty common residue followed by a non-empty varying surface");
    }
    if (new Set(requests.map(request => [...request].slice([...residue].length).join(""))).size !== requests.length) {
      throw new Error("Selected request suffixes are not independently varying");
    }

    const profileIds = [...new Set(selected.map(row => row.profileId))];
    const languageAssignments = await storage.languageIdentities.listProfileLanguages({ profileIds });
    const languageIdentities = new Map((await storage.languageIdentities.listIdentities()).map(identity => [identity.id, identity]));
    const assignmentByProfile = new Map(languageAssignments.map(assignment => [assignment.profileId, assignment.languageId]));
    const documents = selected.map(row => {
      const languageIdentityId = assignmentByProfile.get(row.profileId);
      const languageIdentity = languageIdentityId ? languageIdentities.get(languageIdentityId) : undefined;
      return ({
      sourceVersionId: row.sourceVersionId,
      profileId: row.profileId,
      ...(languageIdentityId && languageIdentity ? {
        languageIdentityId,
        languageIdentityDigest: hasher.digestHex(canonicalStringify({
          schema: "scce.contextual_qa_language_identity_assignment.v1",
          profileId: row.profileId,
          languageIdentityId,
          identity: languageIdentity
        }))
      } : {}),
      spans: row.spans,
      transcriptTurns: [row.request, row.reply]
    });
    });
    const canonical = acquireContextualQaConstructions({ documents, hasher, updatedAt: 1, authorship: "human_authored" });
    const alignments = selected.map(row => {
      const inspected = inspectContextualQaLiteralAnswerAlignment({
        request: row.request.surface,
        reply: row.reply.surface,
        ranges: row.reply.supportingSourceRanges ?? []
      });
      return {
        request: row.request.surface,
        reply: row.reply.surface,
        sourceVersionId: row.sourceVersionId,
        status: inspected.status,
        ...(inspected.status === "bound" ? { selectedAnswer: inspected.selected.answer } : {}),
        candidates: inspected.candidates.map(candidate => candidate.answer),
        candidateShapes: inspected.candidates.map(candidate => inspectMeasuredShape(row, candidate)),
        measuredShape: inspected.status === "bound" ? inspectMeasuredShape(row, inspected.selected) : { status: "unavailable" }
      };
    });

    const bindingId = `scratch.contextual_qa.second_order.${hasher.digestHex(canonicalStringify(requests))}`;
    const relationId = `relation.contextual_qa.${hasher.digestHex(residue)}`;
    const argumentBinding = { relationId, roleId: `${relationId}.role.0`, valueKind: "opaque.contextual_qa.argument" };
    const answerBinding = { relationId, roleId: `${relationId}.role.1`, valueKind: "opaque.contextual_qa.answer" };
    const observations = selected.map(row => requestObservation(row, residue, argumentBinding, answerBinding));
    const leaveOneOut = [];
    for (let heldOutIndex = 0; heldOutIndex < selected.length; heldOutIndex++) {
      const fitIndexes = selected.map((_, index) => index).filter(index => index !== heldOutIndex);
      const compiled = compileRequestOnly({ selected, observations, indexes: fitIndexes, bindingId, hasher,
        acquisitionStatus: "source_observed" });
      const held = selected[heldOutIndex];
      leaveOneOut.push({
        heldOutIndex,
        request: held.request.surface,
        compileStatus: compiled.status,
        ...(compiled.status === "compiled" ? {
          hydrationRejected: compiled.hydrationRejected,
          audit: inspectLearnedRequestOmittedSlot({ bundles: compiled.bundles }, held.request.surface)
        } : { issues: compiled.issues })
      });
    }

    const final = compileRequestOnly({ selected, observations, indexes: selected.map((_, index) => index), bindingId, hasher,
      acquisitionStatus: "document_heldout_qualified" });
    let probeRequestAudit = { status: "unavailable", matchedConstructionIds: [], visited: 0 };
    let probeEvidenceAudit = { status: "unavailable", visited: 0 };
    let probeEvidence = [];
    if (final.status === "compiled") {
      probeRequestAudit = inspectLearnedRequestOmittedSlot({ bundles: final.bundles }, options.probeRequest);
      probeEvidence = (await storage.evidence.searchEvidence({ sourceVersionId: options.probeSourceVersionId,
        status: "promoted", limit: 4096 })).map(row => row.span)
        .filter(span => String(span.sourceVersionId) === options.probeSourceVersionId && span.status === "promoted");
      probeEvidenceAudit = sourceConstructionRequestValueResolver({ bundles: final.bundles,
        graph: { nodes: [], hyperedges: [] } }).inspect(options.probeRequest, probeEvidence);
    }

    const heldoutValueDemands = leaveOneOut.filter(row => row.compileStatus === "compiled" && row.audit.status === "value_demand").length;
    const canonicalReasons = reasonCounts(canonical.rejected);
    const sourceQualified = canonical.families.length > 0;
    const requestGeneralized = final.status === "compiled" && heldoutValueDemands === selected.length
      && probeRequestAudit.status === "value_demand";
    const secondary = runSecondaryResidueProbe({
      selected: corpus.matching.filter(row => row.request.surface.normalize("NFC").startsWith(options.secondaryPrefix.normalize("NFC"))),
      allRequests: corpus.allRequests,
      prefix: options.secondaryPrefix,
      probeRequest: options.secondaryProbeRequest,
      polarProbes: options.secondaryPolarProbes,
      hasher
    });
    return {
      schema: "scce.scratch_contextual_qa_second_order_probe.v1",
      mode: "read_only",
      configPath: options.configPath,
      database: databaseName(config.database.url),
      corpus: { uriPrefix: DOLLY_URI_PREFIX, selectedExamples: selected.length },
      observedFamily: {
        residue,
        residueCodePoints: [...residue].length,
        requests,
        suffixes: requests.map(request => [...request].slice([...residue].length).join(""))
      },
      literalAnswerAlignment: alignments,
      canonicalAcquisition: { provisional: true,
        caution: "The active inferred-answer verifier is under review; this receipt preserves and reports the original replies but does not treat rebuilt source families as publishable.",
        pairs: canonical.pairs, qualifiedFamilies: canonical.families.length,
        rejected: canonical.rejected, reasonCounts: canonicalReasons },
      forcedRequestOnlyCompilation: {
        bindingId,
        relationId,
        leaveOneOut,
        finalCompileStatus: final.status,
        ...(final.status === "compiled" ? { finalHydrationRejected: final.hydrationRejected,
          constructionCount: final.bundles.reduce((sum, bundle) => sum + bundle.constructions.length, 0) } : { finalIssues: final.issues })
      },
      probe: {
        request: options.probeRequest,
        sourceVersionId: options.probeSourceVersionId,
        evidenceCount: probeEvidence.length,
        requestOnlyOmittedSlot: probeRequestAudit,
        requestPlusEvidenceResolution: probeEvidenceAudit
      },
      secondaryWhichResidue: secondary,
      conclusion: {
        requestSurfaceGeneralizes: requestGeneralized,
        sourceRelationQualified: sourceQualified,
        endToEndGeneralizes: requestGeneralized && sourceQualified && probeEvidenceAudit.status === "bound",
        publishable: requestGeneralized && sourceQualified && probeEvidenceAudit.status === "bound",
        reason: sourceQualified ? "qualified_source_relation_available" : "request_residue_has_no_qualified_source_relation"
      }
    };
  } finally {
    await storage.close();
  }
}

async function loadMatchingDollyPairs(storage, requestPrefixes) {
  const selected = [], allRequests = [];
  let afterSourceVersionId;
  while (true) {
    const page = await storage.evidence.listEvidenceBackedSourceVersions({
      includeUriPrefixes: [DOLLY_URI_PREFIX],
      ...(afterSourceVersionId ? { afterSourceVersionId } : {}),
      orderBySourceVersionId: true,
      excludeTrainingDerived: true,
      limit: 128
    });
    if (!page.length) break;
    for (const row of page) {
      const source = await storage.evidence.sourceVersionById(row.sourceVersionId);
      if (!source) throw new Error(`Missing retained source version ${row.sourceVersionId}`);
      const text = Buffer.from(await storage.blobs.get(source.contentHash)).toString("utf8");
      const turns = await readSourceTranscriptArchive(storage, source, text);
      if (!turns) continue;
      for (const reply of turns) {
        if (reply.commitmentScope !== "external" || !reply.supportingSourceRanges?.length || reply.replyToTurnIndex === undefined) continue;
        const request = turns.find(turn => turn.index === reply.replyToTurnIndex);
        if (!request) continue;
        allRequests.push({ sourceVersionId: String(row.sourceVersionId), surface: request.surface });
        if (!requestPrefixes.some(prefix => request.surface.normalize("NFC").startsWith(prefix.normalize("NFC")))) continue;
        const spans = (await storage.evidence.searchEvidence({ sourceVersionId: row.sourceVersionId,
          status: "promoted", limit: 4096 })).map(result => result.span)
          .filter(span => String(span.sourceVersionId) === String(row.sourceVersionId) && span.status === "promoted");
        const owners = spans.filter(span => [request, reply, ...reply.supportingSourceRanges].every(part =>
          part.startCodePoint >= span.charStart && part.endCodePoint <= span.charEnd
          && [...span.text].slice(part.startCodePoint - span.charStart, part.endCodePoint - span.charStart).join("") === part.surface));
        if (owners.length !== 1) continue;
        const profiles = (await storage.model.listLanguageProfiles({ sourceVersionIds: [source.sourceVersionId], limit: 4096 }))
          .filter(profile => String(profile.sourceVersionId) === String(source.sourceVersionId));
        if (profiles.length !== 1) continue;
        selected.push({ sourceVersionId: String(row.sourceVersionId), profileId: profiles[0].id,
          spans, ownerSpan: owners[0], request, reply });
      }
    }
    afterSourceVersionId = String(page.at(-1).sourceVersionId);
    if (page.length < 128) break;
  }
  return { matching: selected.sort((left, right) => left.request.surface.localeCompare(right.request.surface)
    || left.sourceVersionId.localeCompare(right.sourceVersionId)), allRequests };
}

function runSecondaryResidueProbe({ selected, allRequests, prefix, probeRequest, polarProbes, hasher }) {
  const aligned = selected.flatMap(row => {
    const inspected = inspectContextualQaLiteralAnswerAlignment({ request: row.request.surface, reply: row.reply.surface,
      ranges: row.reply.supportingSourceRanges ?? [] });
    return inspected.status === "bound" ? [{ ...row, alignment: inspected }] : [];
  });
  const independent = [...new Map(aligned.map(row => [row.sourceVersionId, row])).values()];
  const group = firstResidueTriple(independent, prefix);
  if (!group) return {
    prefix,
    alignedRequests: aligned.length,
    independentSources: independent.length,
    groupFound: false,
    exactProbe: { status: "unavailable", matchedConstructionIds: [], visited: 0 },
    polarProbes: polarProbes.map(request => ({ request, audit: { status: "unavailable", matchedConstructionIds: [], visited: 0 } })),
    publishable: false,
    reason: "three_independent_maximal_residue_examples_unavailable"
  };
  const residue = longestCommonCodePointPrefix(group.map(row => row.request.surface));
  const bindingId = `scratch.contextual_qa.secondary.${hasher.digestHex(canonicalStringify(group.map(row => row.request.surface)))}`;
  const relationId = `relation.contextual_qa.${hasher.digestHex(residue)}`;
  const argumentBinding = { relationId, roleId: `${relationId}.role.0`, valueKind: "opaque.contextual_qa.argument" };
  const answerBinding = { relationId, roleId: `${relationId}.role.1`, valueKind: "opaque.contextual_qa.answer" };
  const observations = group.map(row => requestObservation(row, residue, argumentBinding, answerBinding));
  const compiled = compileRequestOnly({ selected: group, observations, indexes: group.map((_, index) => index), bindingId, hasher,
    acquisitionStatus: "source_observed" });
  if (compiled.status !== "compiled") return {
    prefix, alignedRequests: aligned.length, independentSources: independent.length, groupFound: true,
    residue, trainingRequests: group.map(row => row.request.surface), compileStatus: compiled.status, issues: compiled.issues,
    exactProbe: { status: "unavailable", matchedConstructionIds: [], visited: 0 }, publishable: false,
    reason: "request_only_construction_compile_failed"
  };
  const exactProbe = inspectLearnedRequestOmittedSlot({ bundles: compiled.bundles }, probeRequest);
  const uniqueRequests = [...new Set(allRequests.map(row => row.surface))].sort();
  const matches = uniqueRequests.flatMap(request => {
    const audit = inspectLearnedRequestOmittedSlot({ bundles: compiled.bundles }, request);
    return audit.status === "value_demand" ? [{ request, audit }] : [];
  });
  const training = new Set(group.map(row => row.request.surface));
  const outsideTraining = matches.filter(row => !training.has(row.request));
  const crossPrefix = matches.filter(row => !row.request.normalize("NFC").startsWith(prefix.normalize("NFC")));
  const polarAudits = polarProbes.map(request => ({ request,
    audit: inspectLearnedRequestOmittedSlot({ bundles: compiled.bundles }, request) }));
  return {
    prefix,
    alignedRequests: aligned.length,
    independentSources: independent.length,
    groupFound: true,
    maximalRecurringResidue: residue,
    training: group.map(row => ({ sourceVersionId: row.sourceVersionId, request: row.request.surface,
      reply: row.reply.surface, alignedAnswer: row.alignment.selected.answer })),
    compileStatus: compiled.status,
    hydrationRejected: compiled.hydrationRejected,
    exactProbe,
    corpusCollisionAudit: {
      retainedExternalRequests: uniqueRequests.length,
      valueDemandMatches: matches.length,
      outsideTrainingMatches: outsideTraining.length,
      crossPrefixMatches: crossPrefix.length,
      crossPrefixSamples: crossPrefix.slice(0, 12).map(row => row.request),
      outsideTrainingSamples: outsideTraining.slice(0, 12).map(row => row.request)
    },
    polarProbes: polarAudits,
    requestSurfaceGeneralizes: exactProbe.status === "value_demand",
    publishable: false,
    reason: exactProbe.status === "value_demand"
      ? "generic_residue_conflates_untyped_which_requests"
      : "exact_probe_not_uniquely_interpreted"
  };
}

function firstResidueTriple(rows, prefix) {
  const normalizedPrefix = prefix.normalize("NFC").trimEnd();
  for (let left = 0; left < rows.length; left++) for (let middle = left + 1; middle < rows.length; middle++) {
    for (let right = middle + 1; right < rows.length; right++) {
      const group = [rows[left], rows[middle], rows[right]];
      const residue = longestCommonCodePointPrefix(group.map(row => row.request.surface));
      if (residue.trimEnd() === normalizedPrefix) return group;
    }
  }
  return undefined;
}

function requestObservation(row, residue, argumentBinding, answerBinding) {
  const residueLength = [...residue].length;
  const requestLength = [...row.request.surface].length;
  return {
    sourceVersionId: row.sourceVersionId,
    evidenceId: String(row.ownerSpan.id),
    surfaceStartCodePoint: row.request.startCodePoint - row.ownerSpan.charStart,
    surfaceEndCodePoint: row.request.endCodePoint - row.ownerSpan.charStart,
    roles: [{ slotIndex: 0, startCodePoint: residueLength, endCodePoint: requestLength, graphBinding: argumentBinding }],
    nullRoles: [{ slotIndex: 1, graphBinding: answerBinding }]
  };
}

function inspectMeasuredShape(row, selected) {
  const range = row.reply.supportingSourceRanges?.[selected.rangeIndex];
  if (!range) return { status: "unavailable", reason: "support_range_missing" };
  const answerStart = selected.sourceStartCodePoint, answerEnd = selected.sourceEndCodePoint;
  const containing = surfaceSentenceRanges(range.surface).filter(sentence => {
    const start = [...range.surface.slice(0, sentence.startUtf16)].length;
    const end = [...range.surface.slice(0, sentence.endUtf16)].length;
    return answerStart >= start && answerEnd <= end;
  });
  if (containing.length !== 1) return { status: "unavailable", reason: "answer_clause_not_identifiable" };
  const sentence = containing[0];
  const sentenceSurface = range.surface.slice(sentence.startUtf16, sentence.endUtf16);
  const clause = sentenceSurface.trim(), leading = sentenceSurface.length - sentenceSurface.trimStart().length;
  const clauseOffset = [...range.surface.slice(0, sentence.startUtf16 + leading)].length;
  const localAnswerStart = answerStart - clauseOffset, localAnswerEnd = answerEnd - clauseOffset;
  const candidates = copiedRequestRoleSpans(row.request.surface, clause, "literal");
  const copied = candidates?.filter(role => candidates.filter(candidate => candidate.slotIndex === role.slotIndex).length === 1);
  if (!copied?.length) return { status: "unavailable", reason: "copied_role_owner_ambiguous", clause };
  const copies = [];
  for (const role of copied) {
    if (role.startCodePoint < localAnswerEnd && role.endCodePoint > localAnswerStart) continue;
    const value = [...clause].slice(role.startCodePoint, role.endCodePoint).join("");
    const owners = occurrences(row.request.surface, value);
    if (owners.length !== 1) continue;
    const requestStart = [...row.request.surface.slice(0, owners[0])].length;
    copies.push({ ...role, value, requestStart, requestEnd: requestStart + [...value].length });
  }
  if (!copies.length) return { status: "unavailable", reason: "query_context_correspondence_missing", clause };
  copies.sort((left, right) => left.startCodePoint - right.startCodePoint);
  copies.forEach((copy, index) => { copy.slotIndex = index; });
  return {
    status: "measured",
    partition: row.reply.sourceFamilyId ?? row.reply.sourceRecordId ?? row.request.sourceRecordId ?? String(row.ownerSpan.sourceId),
    clause,
    answer: selected.answer,
    copies: copies.map(copy => ({ slotIndex: copy.slotIndex, value: copy.value })),
    questionForm: surfaceForm(row.request.surface, copies.map(copy => ({ slotIndex: copy.slotIndex,
      start: copy.requestStart, end: copy.requestEnd }))),
    sourceForm: surfaceForm(clause, [...copies.map(copy => ({ slotIndex: copy.slotIndex,
      start: copy.startCodePoint, end: copy.endCodePoint })), { slotIndex: copies.length, start: localAnswerStart, end: localAnswerEnd }])
  };
}

function occurrences(text, value) {
  const found = [];
  for (let index = text.indexOf(value); index >= 0; index = text.indexOf(value, index + 1)) found.push(index);
  return found;
}

function surfaceForm(text, slots) {
  const points = [...text], parts = [];
  let previous = 0;
  for (const slot of [...slots].sort((left, right) => left.start - right.start)) {
    if (slot.start < previous) return [];
    const literal = points.slice(previous, slot.start).join("");
    if (literal) parts.push(literal);
    parts.push({ slotIndex: slot.slotIndex });
    previous = slot.end;
  }
  const tail = points.slice(previous).join("");
  if (tail) parts.push(tail);
  return parts;
}

function compileRequestOnly({ selected, observations, indexes, bindingId, hasher, acquisitionStatus }) {
  const evidence = [...new Map(indexes.map(index => [String(selected[index].ownerSpan.id), selected[index].ownerSpan])).values()];
  const compiled = compileLanguageConstructionPattern({ bindingId, profileId: selected[indexes[0]].profileId,
    observations: indexes.map(index => observations[index]), evidence, hasher, updatedAt: 1,
    acquisitionStatus, storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE });
  if (compiled.status !== "compiled") return compiled;
  const hydrated = hydrateLanguageConstructionPatterns({ patterns: [compiled.pattern], evidence, hasher });
  return { status: "compiled", bundles: hydrated.bundles, hydrationRejected: hydrated.rejected };
}

function longestCommonCodePointPrefix(values) {
  if (!values.length) return "";
  const points = values.map(value => [...value.normalize("NFC")]);
  let length = 0;
  while (points.every(row => row[length] !== undefined && row[length] === points[0][length])) length++;
  return points[0].slice(0, length).join("");
}

function reasonCounts(rows) {
  return Object.fromEntries([...rows.reduce((counts, row) => counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1), new Map())]
    .sort(([left], [right]) => left.localeCompare(right)));
}

function databaseName(url) {
  try { return new URL(url).pathname.replace(/^\//u, ""); } catch { return "unparseable"; }
}

function parseArguments(argv, cwd = process.cwd()) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) throw new Error(`Invalid argument ${argv[index] ?? ""}`);
    values.set(argv[index].slice(2), argv[index + 1]);
  }
  for (const name of ["config", "request-prefix", "probe-request", "probe-source-version", "secondary-prefix", "secondary-probe-request",
    "secondary-polar-one", "secondary-polar-two"]) {
    if (!values.get(name)?.trim()) throw new Error(`--${name} is required`);
  }
  const expectedExamples = Number(values.get("expected-examples") ?? "4");
  if (!Number.isSafeInteger(expectedExamples) || expectedExamples < 3) throw new Error("--expected-examples must be an integer of at least 3");
  return {
    configPath: path.resolve(cwd, values.get("config")),
    requestPrefix: values.get("request-prefix"),
    probeRequest: values.get("probe-request"),
    probeSourceVersionId: values.get("probe-source-version"),
    secondaryPrefix: values.get("secondary-prefix"),
    secondaryProbeRequest: values.get("secondary-probe-request"),
    secondaryPolarProbes: [values.get("secondary-polar-one"), values.get("secondary-polar-two")],
    expectedExamples
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const result = await runContextualQaSecondOrderProbe(parseArguments(process.argv.slice(2)));
    console.log(JSON.stringify(process.env.SCCE_CONTEXTUAL_QA_COMPACT === "1" ? {
      canonicalAcquisition: {
        qualifiedFamilies: result.canonicalAcquisition.qualifiedFamilies,
        reasonCounts: result.canonicalAcquisition.reasonCounts
      },
      conclusion: result.conclusion
    } : result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ schema: "scce.scratch_contextual_qa_second_order_probe.v1", status: "failed",
      message: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
