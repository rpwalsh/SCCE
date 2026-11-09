#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {hydrateLanguageConstructionPatterns,realizeLearnedSurface,createHasher} from '../../packages/kernel/dist/index.js';

export async function constructionDiagnostic(client,schema){
 if(!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(schema))throw new Error('Invalid schema');
 const q='"'+schema+'"',hasher=createHasher();
 const result={schema:'scce.stored_construction_diagnostic.v1',startedAt:new Date().toISOString(),readOnlyApplicationData:true,
  selection:'First 12 Wikipedia source-example patterns ordered by support descending then id; no new training',replays:[],recombinations:[]};
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  const rows=(await client.query(`SELECT * FROM ${q}.language_patterns WHERE source_system='wikipedia' AND pattern_json->>'schema'='scce.language_construction_pattern.v1' ORDER BY support DESC,id LIMIT 12`)).rows;
  const patterns=rows.map(r=>({id:r.id,profileId:r.profile_id,patternKind:r.pattern_kind,support:r.support,entropy:r.entropy,patternJson:r.pattern_json,evidenceIds:r.evidence_ids,updatedAt:new Date(r.updated_at).getTime()}));
  const ids=[...new Set(patterns.flatMap(p=>[...p.evidenceIds,...(p.patternJson.bundle?.evidenceIds??[])]))];
  const erows=ids.length?(await client.query(`SELECT * FROM ${q}.evidence_spans WHERE id=ANY($1::text[])`,[ids])).rows:[];
  const evidence=erows.map(r=>({id:r.id,sourceId:r.source_id,sourceVersionId:r.source_version_id,chunkId:r.chunk_id,contentHash:r.content_hash,
   mediaType:r.media_type,byteStart:Number(r.byte_start),byteEnd:Number(r.byte_end),charStart:Number(r.char_start),charEnd:Number(r.char_end),
   text:r.text_content,textPreview:r.text_preview,languageHints:r.language_hints,scriptHints:r.script_hints,trustVector:r.trust_vector,
   provenance:r.provenance_json,features:r.features,status:r.status,alpha:r.alpha,observedAt:new Date(r.observed_at).getTime(),informationLabel:r.information_label}));
  const hydrated=hydrateLanguageConstructionPatterns({patterns,evidence,hasher});
  result.selectedPatterns=patterns.length;result.hydratedBundles=hydrated.bundles.length;result.rejected=hydrated.rejected;
  for(const bundle of hydrated.bundles){
   const example=bundle.sourceExamples[0];if(!example)continue;
   const plan={id:'diagnostic.plan.'+example.id,profileKey:bundle.targetProfileId,
    roleSignature:[...new Set([...example.roles,...example.nullRoles].map(r=>r.roleId))],
    slots:[...example.roles.map(r=>({roleId:r.roleId,occurrenceId:r.occurrenceId,variants:[{id:'diagnostic.variant.'+r.occurrenceId,profileKey:bundle.targetProfileId,surface:r.surface,evidenceIds:[example.evidenceId],support:1}]})),
     ...example.nullRoles.map(r=>({roleId:r.roleId,occurrenceId:r.occurrenceId,realization:'null',variants:[],evidenceIds:[example.evidenceId]}))]};
   const replay=realizeLearnedSurface({plan,constructions:bundle.constructions,formClasses:bundle.formClasses,hasher});
   result.replays.push({bundleId:bundle.id,exampleId:example.id,sourceSurface:example.surface,status:replay.status,
    realizedSurface:replay.realization?.text??'',exactSourceRecovered:replay.realization?.text===example.surface,rejection:replay.rejection});
   let chosen;
   for(const role of example.roles){
    for(const other of bundle.sourceExamples){
     const replacement=other.roles.find(r=>r.roleId===role.roleId&&r.occurrenceId===role.occurrenceId&&r.surface!==role.surface);
     if(replacement){chosen={role,other,replacement};break;}
    }
    if(chosen)break;
   }
   if(!chosen)continue;
   const changed=structuredClone(plan),slot=changed.slots.find(s=>s.occurrenceId===chosen.role.occurrenceId);
   slot.variants=[{id:'diagnostic.recombined.'+chosen.replacement.occurrenceId,profileKey:bundle.targetProfileId,
    surface:chosen.replacement.surface,evidenceIds:[chosen.other.evidenceId],support:1}];
   const emitted=realizeLearnedSurface({plan:changed,constructions:bundle.constructions,formClasses:bundle.formClasses,hasher});
   result.recombinations.push({bundleId:bundle.id,original:example.surface,replacedRoleId:chosen.role.roleId,
    originalSlot:chosen.role.surface,replacementSlot:chosen.replacement.surface,status:emitted.status,
    realizedSurface:emitted.realization?.text??'',surfaceNotInBundleExamples:emitted.status==='realized'&&!bundle.sourceExamples.some(e=>e.surface===emitted.realization.text),rejection:emitted.rejection});
  }
  result.completed=true;
  result.qualification='Typed meaning plans built from stored source roles; parser and request routing are bypassed. Exact replay proves hydration/realization integrity, not general English. Recombination is attempted only when the same stored bundle has an alternative observed role filler; no invented training examples or rules are supplied.';
  return result;
 }finally{await client.query('ROLLBACK');result.finishedAt=new Date().toISOString();}
}
