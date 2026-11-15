// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {createReadStream} from "node:fs";
import {open} from "node:fs/promises";
import {createGunzip} from "node:zlib";
import {createHasher,normalizeInformationLabel,selectLanguageIdentityForSurface,toJsonValue,type InformationLabel,type JsonValue,type ScceStorage} from "@scce/kernel";
import {trainLanguageCorpusText,type SourceOwnedPatternProjection} from "./language-corpus-trainer.js";

export interface SourceLexicalPattern {
  key:string; patternJson:JsonValue; support:number; ranges:Array<{start:number;end:number}>;
}
export interface LexicalCorpusLimits { maxSourceBytes:number; }
export class LexicalCorpusCapacityError extends Error {
  constructor(readonly maxSourceBytes:number){super(`lexical source exceeds the explicit ${maxSourceBytes}-byte capacity; no partial source was imported`);this.name="LexicalCorpusCapacityError";}
}
export function assertLexicalCorpusCapacity(text:string,limits:LexicalCorpusLimits):void {
  if(!Number.isSafeInteger(limits.maxSourceBytes)||limits.maxSourceBytes<=0)throw new Error("maxSourceBytes must be an explicit positive integer");
  if(Buffer.byteLength(text)>limits.maxSourceBytes)throw new LexicalCorpusCapacityError(limits.maxSourceBytes);
}

/** This whole-source parser path has an explicit capacity; decompression never retains beyond it. */
export async function readBoundedLexicalCorpusSource(input:{path:string;maxSourceBytes:number}):Promise<string>{
  assertLexicalCorpusCapacity("",input);
  const file=await open(input.path,"r");
  let compressed=false;
  try{const stat=await file.stat();if(stat.size>input.maxSourceBytes)throw new LexicalCorpusCapacityError(input.maxSourceBytes);
    const header=Buffer.alloc(2);await file.read(header,0,2,0);compressed=header[0]===0x1f&&header[1]===0x8b;
  }finally{await file.close();}
  const source=createReadStream(input.path,{highWaterMark:Math.min(input.maxSourceBytes,64*1024)});
  let encoded=0;source.on("data",chunk=>{encoded+=Buffer.byteLength(chunk);if(encoded>input.maxSourceBytes)source.destroy(new LexicalCorpusCapacityError(input.maxSourceBytes));});
  const decoder=compressed?createGunzip():undefined;
  if(decoder)source.on("error",error=>decoder.destroy(error));
  const stream=decoder?source.pipe(decoder):source,chunks:Buffer[]=[];
  let decoded=0;
  try{for await(const chunk of stream){const bytes=Buffer.from(chunk as Uint8Array);decoded+=bytes.length;
    if(decoded>input.maxSourceBytes)throw new LexicalCorpusCapacityError(input.maxSourceBytes);chunks.push(bytes);}
    return new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks,decoded));
  }finally{source.destroy();decoder?.destroy();}
}

export async function persistLexicalCorpus(input:{storage:ScceStorage;text:string;sourceUri:string;languageText:string;
  lexiconId:string;language:string;license:string;informationLabel:InformationLabel;maxSourceBytes:number;mediaType?:string;
  patterns:SourceLexicalPattern[];updatedAt?:number;batchSize?:number;
  onProgress?:(value:{patterns:number;totalPatterns:number;evidence:number})=>void}){
  assertLexicalCorpusCapacity(input.text,input);
  assertLexicalCorpusCapacity(input.languageText,input);
  if(!input.informationLabel)throw new Error("lexical ingestion requires an explicit source information label");
  const informationLabel=normalizeInformationLabel(input.informationLabel);
  if(!input.lexiconId||!input.language||!input.license)throw new Error("lexical source needs lexicon identity, language and license");
  if(!input.patterns.length)throw new Error("lexical source has no annotations");
  if(!input.storage.languageIdentities)throw new Error("lexical ingestion requires the language identity store");
  const language=selectLanguageIdentityForSurface(await input.storage.languageIdentities.listIdentities(),input.languageText);
  if(!language||language.coverage===0)throw new Error("lexical source has no measured resident language identity");
  const projections=new Map<string,{patternSchema:string;componentRecipe:string;patterns:SourceLexicalPattern[]}>();
  for(const pattern of input.patterns){const row=pattern.patternJson as {schema?:string;componentRecipe?:string};
    if(!row.schema||!row.componentRecipe)throw new Error("lexical annotation needs its source compiler schema and recipe");
    const projection=projections.get(row.schema)??{patternSchema:row.schema,componentRecipe:row.componentRecipe,patterns:[]};
    if(projection.componentRecipe!==row.componentRecipe)throw new Error("conflicting lexical component recipes");
    projection.patterns.push({...pattern,patternJson:toJsonValue({...pattern.patternJson as object,lexiconId:input.lexiconId,language:input.language})});projections.set(row.schema,projection);
  }
  const recipes=[...projections.values()].map(row=>[row.patternSchema,row.componentRecipe]).sort();
  const derivativeUri=`${input.sourceUri}#scce-lexical-language=${encodeURIComponent(JSON.stringify(recipes))}`;
  const bytes=Buffer.from(input.text,"utf8"),transformId=`scce.lexical_language_projection:${JSON.stringify(recipes)}`;
  input.onProgress?.({patterns:0,totalPatterns:input.patterns.length,evidence:0});
  const report=await trainLanguageCorpusText({storage:input.storage,sourceSystem:"workspace",sourceKind:"lexical_knowledge",
    streamUri:derivativeUri,sourceUri:derivativeUri,text:input.languageText,exactSourceText:true,informationLabel,
    ...(input.updatedAt===undefined?{}:{createdAt:input.updatedAt}),languageOnly:true,skipNgramPersistence:true,languageAliases:[input.language],
    profileLanguageIdentityId:language.identity.id,sourceOwnedPatternProjections:[...projections.values()] satisfies SourceOwnedPatternProjection[],
    corpusMetadata:toJsonValue({sourceKind:"lexical_knowledge",lexiconId:input.lexiconId,language:input.language,license:input.license}),
    originalSource:{bytes,sourceUri:input.sourceUri,mediaType:input.mediaType??"text/plain",transformId,kind:"extracted-text",originalCoordinateSpace:"source-bytes"},
    corpusCheckpoint:{rootUri:input.sourceUri,itemUri:derivativeUri,contentHash:`sha256_${createHasher().digestHex(bytes)}`,byteLength:bytes.length,transformId,originalSourceUri:input.sourceUri}});
  input.onProgress?.({patterns:input.patterns.length,totalPatterns:input.patterns.length,evidence:report.evidence});
  return {status:"complete" as const,lexiconId:input.lexiconId,language:input.language,languageIdentityId:language.identity.id,
    profileId:report.artifacts.languageProfileId,sourceVersionId:report.sourceVersionId,annotationSourceVersionId:report.originalSourceVersionId,
    contentHash:report.sourceContentHash,patterns:input.patterns.length,evidence:report.evidence,license:input.license,checkpointed:true};
}
