// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {expect,it} from 'vitest';
import {createClock,createHasher,createIdFactory,canonicalCorpusSourceSystemId,type EvidenceSpan,type LanguagePatternRecord,type SourceVersion} from '@scce/kernel';
import {storageFixtureForEvaluation} from '../../../kernel/src/__tests__/evidence-promotion-evaluation-fixture.js';
import {prepareLanguageCorpusTraining,commitLanguageCorpusTraining,type LanguageCorpusTrainingInput} from '../language-corpus-trainer.js';

it('prepares and ordinarily publishes all 243488 witnesses and 131073 source-owned patterns beyond the call argument limit',async()=>{
 const witnessCount=243488,patternCount=131073,schema='fixture.source_owned_scale.v1',recipe='fixture.source_owned_scale.v1';
 const label={tenantId:'scale.owner',principals:[],compartments:[],exportClass:'public' as const,mergePolicy:'same_owner' as const};
 const raw=Array.from({length:witnessCount},(_,i)=>String(i).padStart(6,'0')).join('\n'),bytes=Buffer.from(raw);
 const declarations=Array.from({length:patternCount},(_,i)=>({key:String(i),support:1,
  ranges:[{start:i*7,end:i*7+6},...(i+patternCount<witnessCount?[{start:(i+patternCount)*7,end:(i+patternCount)*7+6}]:[])],
  patternJson:{schema,componentRecipe:recipe,ordinal:i}}));
 const {storage}=storageFixtureForEvaluation({evidence:[],clockNow:()=>1});
 const hasher=createHasher(),clock=createClock({fixedTime:1}),system=canonicalCorpusSourceSystemId('workspace');
 const ids=createIdFactory({clock,hasher,namespace:`corpus-${hasher.digestHex(system).slice(0,12)}`});
 const sources=new Map<string,SourceVersion>();let original:SourceVersion,derivative:SourceVersion;
 let evidenceCount=0,annotationCount=0,rangeCount=0,annotationPatternCount=0,observations=0,models=0;
 let firstSpan:EvidenceSpan|undefined,lastSpan:EvidenceSpan|undefined,firstPattern:LanguagePatternRecord|undefined,lastPattern:LanguagePatternRecord|undefined;
 let compilation:Record<string,unknown>|undefined,transactions=0;
 storage.transaction=async operation=>{transactions++;return operation();};
 storage.evidence.putSourceVersion=async source=>{sources.set(source.sourceVersionId,source);if(source.role==='original')original=source;else derivative=source;};
 storage.evidence.sourceVersionById=async id=>sources.get(id)??null;
 storage.evidence.putEvidenceSpans=async spans=>{
  evidenceCount+=spans.length;
  for(const span of spans){
   if(span.sourceVersionId!==original!.sourceVersionId)continue;
   const ordinal=annotationCount++;if(!firstSpan)firstSpan=span;lastSpan=span;
   if(span.byteStart!==ordinal*7||span.byteEnd!==ordinal*7+6||span.charStart!==ordinal*7||span.charEnd!==ordinal*7+6
    ||span.text!==String(ordinal).padStart(6,'0')||span.sourceId!==original!.sourceId||span.status!=='promoted'
    ||span.informationLabel?.tenantId!==label.tenantId)throw Error(`lost or reordered source witness ${ordinal}`);
  }
 };
 storage.evidence.putEvidenceSpan=async()=>{throw Error('batch evidence store required');};
 storage.blobs.put=async content=>`sha256_${hasher.digestHex(content)}` as SourceVersion['contentHash'];
 storage.blobs.putRanges=async(ranges,parent)=>{
  if(parent.contentHash!==`sha256_${hasher.digestHex(bytes)}`)return;
  rangeCount+=ranges.length;
  for(let i=0;i<ranges.length;i++)if(ranges[i]!.byteStart!==i*7||ranges[i]!.byteEnd!==i*7+6)throw Error('blob range order differs');
 };
 storage.languageMemory.putNgramObservationsBatch=async rows=>{observations+=rows.length;};
 storage.languageMemory.putNgramModels=async rows=>{models+=rows.length;};
 storage.languageMemory.putLanguagePatterns=async rows=>{for(const row of rows)if(row.patternKind==='source_compilation')compilation=(row.patternJson as Record<string,unknown>).compilation as Record<string,unknown>;};
 storage.languageMemory.replaceLanguagePatternProjection=async({projection,patterns})=>{
  if(projection.patternSchema!==schema)return;
  expect(projection.informationLabel).toEqual(label);expect(projection.sourceVersionId).toBe(derivative!.sourceVersionId);
  expect(projection.sourceDependencies?.map(dep=>dep.sourceVersionId)).toEqual([derivative!.sourceVersionId,original!.sourceVersionId]);
  expect(projection.sourceDependencies![1]!.evidenceIds).toHaveLength(witnessCount);
  expect(projection.patternIds).toHaveLength(patternCount);
  const physicalIds:string[]=[];
  for(const row of patterns){
   const value=row.patternJson as Record<string,unknown>;
   // The first projection also publishes the compiler's non-projection artifacts and receipt.
   if(value.schema!==schema)continue;
   const ordinal=annotationPatternCount++;
   if(!firstPattern)firstPattern=row;lastPattern=row;physicalIds.push(row.id);
   if(value.ordinal!==ordinal||value.sourceVersionId!==derivative!.sourceVersionId||value.annotationSourceVersionId!==original!.sourceVersionId
    ||value.profileId!==projection.profileId||value.sourceSystem!=='workspace'||row.informationLabel?.tenantId!==label.tenantId
    ||row.evidenceIds.length!==declarations[ordinal]!.ranges.length)throw Error(`lost or reordered source annotation ${ordinal}`);
   const expected=ids.evidenceId({sourceVersionId:original!.sourceVersionId,byteStart:ordinal*7,byteEnd:ordinal*7+6,
    spanHash:`sha256_${hasher.digestHex(String(ordinal).padStart(6,'0'))}` as never});
   if(row.evidenceIds[0]!==expected)throw Error(`annotation evidence identity differs ${ordinal}`);
  }
  expect(physicalIds.sort()).toEqual(projection.patternIds);
 };
 const input:LanguageCorpusTrainingInput={storage,sourceSystem:'workspace',sourceKind:'lexical_knowledge',streamUri:'fixture://scale/derived',
  sourceUri:'fixture://scale/derived',text:'A measured source.',exactSourceText:true,informationLabel:label,createdAt:1,clock,idFactory:ids,
  languageOnly:true,skipNgramPersistence:true,ngramMaxOrder:1,ngramMaxCountersPerOrder:16,ngramVocabularyLimit:16,
  originalSource:{bytes,sourceUri:'fixture://scale/raw',mediaType:'text/plain',transformId:'fixture.scale.v1'},
  sourceOwnedPatternProjections:[{patternSchema:schema,componentRecipe:recipe,patterns:declarations}]};
 const prepared=await prepareLanguageCorpusTraining(input);
 expect(transactions).toBe(0);
 const report=await commitLanguageCorpusTraining(input,prepared);
 expect(transactions).toBe(1);expect(sources.size).toBe(2);
 expect(annotationCount).toBe(witnessCount);expect(rangeCount).toBe(witnessCount);expect(evidenceCount).toBe(report.evidence);
 expect(annotationPatternCount).toBe(patternCount);expect(report.sourceOwnedPatternProjections?.find(p=>p.patternSchema===schema)?.patternIds).toHaveLength(patternCount);
 expect(firstSpan?.text).toBe('000000');expect(lastSpan?.text).toBe('243487');
 expect(firstSpan?.chunkId).toBe(ids.chunkId({sourceVersionId:original!.sourceVersionId,byteStart:0,byteEnd:6,chunkHash:firstSpan!.contentHash}));
 expect(lastSpan?.chunkId).toBe(ids.chunkId({sourceVersionId:original!.sourceVersionId,byteStart:(witnessCount-1)*7,byteEnd:(witnessCount-1)*7+6,chunkHash:lastSpan!.contentHash}));
 expect((firstPattern?.patternJson as Record<string,unknown>).ordinal).toBe(0);expect((lastPattern?.patternJson as Record<string,unknown>).ordinal).toBe(patternCount-1);
 expect(compilation).toMatchObject({chunkCount:0,modelInventory:[],options:{artifactScope:'artifacts_only'}});
 expect(observations).toBe(0);expect(models).toBe(0);
},120000);
