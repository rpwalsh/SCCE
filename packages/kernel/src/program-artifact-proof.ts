// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {canonicalStringify,createHasher} from "./primitives.js";
import type {EvidenceSpan,JsonValue,ProgramBehaviorRequirement,ProgramStatefulBehaviorRequirement,SemanticEntailmentResult} from "./types.js";
/** Stable construction binding; the executing episode retains the actual proof receipt and its identity. */
export function programArtifactProofBinding(input:{requestText:string;entailment:SemanticEntailmentResult;evidence:readonly EvidenceSpan[];requirements:readonly (ProgramBehaviorRequirement|ProgramStatefulBehaviorRequirement)[];ownerScope:JsonValue}):JsonValue {
 const value=input.entailment,claim=value.claim;
 const semantics={requestText:input.requestText,claim:claim?{text:claim.text,normalized:claim.normalized,features:claim.features,polarity:claim.polarity}:null,
  force:value.force,verdict:value.verdict,semanticVerdict:value.semanticVerdict,
  evidenceIds:value.evidenceIds??[],proofEvidenceIds:value.proof.evidenceIds??[],
  sourceOwners:input.evidence.map(span=>({sourceId:span.sourceId,sourceVersionId:span.sourceVersionId,contentHash:span.contentHash,informationLabel:span.informationLabel??null})),
  obligations:value.obligations.map(obligation=>{const row={...obligation} as Record<string,unknown>;delete row.id;return row;}),
  ownerScope:input.ownerScope,requirements:input.requirements};
 return {schema:"scce.program.artifact_proof_binding.v1",digest:`sha256_${createHasher().digestHex(canonicalStringify(semantics))}`};
}
