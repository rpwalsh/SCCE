// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it, vi } from "vitest";
import { CONTEXTUAL_QA_COMPILER_FINGERPRINT, CONTEXTUAL_QA_CONSTRUCTION_RECIPE, CONTEXTUAL_QA_SOURCE_SYSTEM,
  LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, canonicalStringify, createHasher, toJsonValue,
  type IngestionCheckpoint, type LanguagePatternProjection, type ScceStorage } from "@scce/kernel";
import { prepareDialogueSourceComponentBinding, runDialogueContextualQaComponent } from "../dialogue-conversational-checkpoint.js";

it("never treats missing owned contextual-QA publications as a completed checkpoint", async () => {
  const rootUri = "fixture://contextual-qa-v5", informationLabel = { tenantId: "owner", principals: ["owner"], compartments: [],
    exportClass: "restricted" as const, mergePolicy: "isolated" as const };
  const sources = [{ sourceUri: "fixture://contextual-qa-v5/source", sourceVersionId: "version.source",
    contentHash: "sha256_source", byteLength: 17, transcriptDigest: "sha256_transcript" }];
  const { binding, byteLength } = prepareDialogueSourceComponentBinding({ rootUri, informationLabel, authorship: "human_authored", sources });
  const contentHash = createHasher().digestHex(binding), id = `dialogue_contextual_qa_compilation_${contentHash}`;
  const checkpoints = new Map<string, IngestionCheckpoint>([[id, { id, rootUri, itemUri: rootUri, phase: "stored", status: "complete",
    offsetBytes: byteLength, contentHash: contentHash as IngestionCheckpoint["contentHash"], byteLength, updatedAt: 1,
    metadata: toJsonValue({ schema: "scce.dialogue_contextual_qa_compilation.v1", binding,
      compilerFingerprint: CONTEXTUAL_QA_COMPILER_FINGERPRINT, projections: [] }) }]]);
  const storage = {
    ingestion: { get: async (key: string) => checkpoints.get(key) ?? null,
      put: async (row: IngestionCheckpoint) => { checkpoints.set(row.id, structuredClone(row)); }, list: async () => [...checkpoints.values()] },
    languageMemory: { getLanguagePatternProjection: async () => undefined, listLanguagePatterns: async () => [] },
    transaction: async <T>(work: () => Promise<T>) => work()
  } as unknown as ScceStorage;
  const compile = vi.fn(async () => ({ report: "compiled", projections: [] }));
  const input = { storage, rootUri, informationLabel, authorship: "human_authored", sources, compile, unchanged: () => "unchanged" };

  expect(await runDialogueContextualQaComponent(input)).toBe("compiled");
  expect(compile).toHaveBeenCalledTimes(1);
  const metadata = checkpoints.get(id)!.metadata as Record<string, unknown>;
  expect(metadata.compilerFingerprint).toBe(CONTEXTUAL_QA_COMPILER_FINGERPRINT);
  expect(CONTEXTUAL_QA_COMPILER_FINGERPRINT).toBe("kernel.dialogue_contextual_qa.compiler.v12");
  expect(metadata.projections).toEqual([]);

  expect(await runDialogueContextualQaComponent(input)).toBe("compiled");
  expect(compile).toHaveBeenCalledTimes(2);
});

type EmptyReport = { schema: "scce.dialogue_contextual_qa_report.v1"; compilerFingerprint: string; pairs: number;
  patternsPersisted: number; qualifiedFamilies: number; familyApplicability: []; rejected: Array<{bindingId: string; reason: string}>; unchanged: boolean };
function emptyFixture(saved?: { checkpoints: IngestionCheckpoint[]; projections: LanguagePatternProjection[]; owners: any[] }) {
  const hasher=createHasher(),rootUri="fixture://qa-empty-pool",informationLabel={tenantId:"owner",principals:["owner"],compartments:[],exportClass:"restricted" as const,mergePolicy:"isolated" as const};
  const sources=["one","two"].map(name=>({sourceUri:`fixture://qa-empty/${name}`,sourceVersionId:`version.${name}`,contentHash:hasher.digestHex(`raw ${name}`),
    byteLength:Buffer.byteLength(`raw ${name}`),transcriptDigest:hasher.digestHex(`turns ${name}`),languageIdentityId:"identity.measured",languageIdentityDigest:hasher.digestHex("exact identity assignment")}));
  const owners=new Map((saved?.owners??sources.map(source=>({sourceId:`source.${source.sourceVersionId}`,sourceVersionId:source.sourceVersionId,canonicalUri:source.sourceUri,
    contentHash:`sha256_${source.contentHash}`,byteLength:source.byteLength,informationLabel}))).map(row=>[String(row.sourceVersionId),structuredClone(row)]));
  const checkpoints=new Map((saved?.checkpoints??[]).map(row=>[row.id,structuredClone(row)]));
  const key=(projection:LanguagePatternProjection)=>`${projection.sourceId}:${projection.componentRecipe}`;
  const projections=new Map((saved?.projections??[]).map(row=>[key(row),structuredClone(row)]));
  const writes:string[]=[],sourceReads:string[]=[];
  const storage={ingestion:{get:async(id:string)=>structuredClone(checkpoints.get(id)??null),put:async(row:IngestionCheckpoint)=>{writes.push("checkpoint");checkpoints.set(row.id,structuredClone(row));}},
    evidence:{sourceVersionById:async(id:string)=>{sourceReads.push(id);return structuredClone(owners.get(id)??null);}},
    languageMemory:{getLanguagePatternProjection:async(query:LanguagePatternProjection)=>{
      const row=projections.get(key(query));return row&&row.profileId===query.profileId&&row.sourceVersionId===query.sourceVersionId?structuredClone(row):undefined;
    },listLanguagePatterns:async()=>[],replaceLanguagePatternProjection:async({projection,patterns}:{projection:LanguagePatternProjection;patterns:unknown[]})=>{
      expect(patterns).toEqual([]);writes.push("projection");projections.set(key(projection),structuredClone(projection));
    }},transaction:async<T>(work:()=>Promise<T>)=>work()} as unknown as ScceStorage;
  const report:EmptyReport={schema:"scce.dialogue_contextual_qa_report.v1",compilerFingerprint:CONTEXTUAL_QA_COMPILER_FINGERPRINT,pairs:3971,patternsPersisted:0,qualifiedFamilies:0,familyApplicability:[],
    rejected:[{bindingId:"binding.one/\u65e5\u672c\u8a9e",reason:"verified_language_identity_required"},{bindingId:"binding.two/\u{1f9ed}",reason:"independent_role_contrast_missing"}],unchanged:false};
  const prepare=vi.fn(async()=>({computed:true}));
  const compile=vi.fn(async(_prepared:{computed:boolean})=>{const published:LanguagePatternProjection[]=[];for(const source of sources){const owner=owners.get(source.sourceVersionId)!;
    const projection:LanguagePatternProjection={profileId:`profile.${source.sourceVersionId}`,sourceId:owner.sourceId,sourceVersionId:source.sourceVersionId as never,sourceSystem:CONTEXTUAL_QA_SOURCE_SYSTEM,
      patternSchema:LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA,componentRecipe:CONTEXTUAL_QA_CONSTRUCTION_RECIPE,patternIds:[],informationLabel,sourceDependencies:[]};
    await storage.languageMemory.replaceLanguagePatternProjection!({projection,patterns:[]});published.push(projection);
  }return{report:structuredClone(report),projections:published};});
  const input={storage,rootUri,informationLabel,authorship:"human_authored",sources,prepare,compile,unchanged:(previous?:EmptyReport):EmptyReport=>previous?{...previous,unchanged:true}:{...report,pairs:0,rejected:[],unchanged:true}};
  const snapshot=()=>structuredClone({checkpoints:[...checkpoints.values()],projections:[...projections.values()],owners:[...owners.values()]});
  return{input,storage,sources,owners,checkpoints,projections,prepare,compile,report,writes,sourceReads,snapshot};
}

it("durably replays a complete explicitly empty QA pool through a fresh reader without acquisition or writes",async()=>{
  const first=emptyFixture();expect(await runDialogueContextualQaComponent(first.input)).toEqual(first.report);
  expect(first.prepare).toHaveBeenCalledTimes(1);expect(first.compile).toHaveBeenCalledTimes(1);
  expect(first.writes).toEqual(["checkpoint","projection","projection","checkpoint"]);
  const checkpoint=[...first.checkpoints.values()][0]!;expect(checkpoint).toMatchObject({phase:"stored",status:"complete"});
  const metadata=checkpoint.metadata as Record<string,any>;expect(metadata.projections).toHaveLength(2);
  expect(metadata.emptyResult.report).toEqual(first.report);expect(metadata.emptyResult.reportDigest).toBe(createHasher().digestHex(canonicalStringify(first.report)));
  for(const projection of first.projections.values())expect(JSON.stringify(projection)).not.toContain("binding.one");
  const cold=emptyFixture(first.snapshot()),before=cold.snapshot();
  const replay=await runDialogueContextualQaComponent(cold.input);expect(replay).toEqual({...first.report,unchanged:true});
  expect(cold.prepare).not.toHaveBeenCalled();expect(cold.compile).not.toHaveBeenCalled();expect(cold.writes).toEqual([]);expect(cold.snapshot()).toEqual(before);
  expect(cold.sourceReads.sort()).toEqual(cold.sources.map(row=>row.sourceVersionId).sort());
  replay.rejected[0]!.reason="caller mutation";expect((await runDialogueContextualQaComponent(cold.input)).rejected).toEqual(first.report.rejected);
});

it.each(["running","partial-offset","compiler","missing-header","partial","duplicate-owner","missing-result","changed-result","source-hash","source-label","source-uri","identity-binding"])
  ("does not reuse an invalid empty result: %s",async damage=>{
  const initial=emptyFixture();await runDialogueContextualQaComponent(initial.input);const cold=emptyFixture(initial.snapshot());
  const checkpoint=[...cold.checkpoints.values()][0]!,metadata=checkpoint.metadata as Record<string,any>;
  if(damage==="running"){checkpoint.status="running";checkpoint.phase="extracting";}
  if(damage==="partial-offset")checkpoint.offsetBytes=0;
  if(damage==="compiler")metadata.compilerFingerprint="kernel.dialogue_contextual_qa.compiler.old";
  if(damage==="missing-header")cold.projections.delete([...cold.projections.keys()][0]!);
  if(damage==="partial")metadata.projections=metadata.projections.slice(0,1);
  if(damage==="duplicate-owner")metadata.projections=[metadata.projections[0],metadata.projections[0]];
  if(damage==="missing-result")delete metadata.emptyResult;
  if(damage==="changed-result")metadata.emptyResult.report.rejected[0].reason="altered diagnostic";
  if(damage==="source-hash")cold.owners.get(cold.sources[0]!.sourceVersionId)!.contentHash=`sha256_${createHasher().digestHex("changed raw source")}`;
  if(damage==="source-label")cold.owners.get(cold.sources[0]!.sourceVersionId)!.informationLabel={...cold.input.informationLabel,tenantId:"foreign"};
  if(damage==="source-uri")cold.owners.get(cold.sources[0]!.sourceVersionId)!.canonicalUri="fixture://another-source";
  if(damage==="identity-binding")cold.sources[0]!.languageIdentityDigest=createHasher().digestHex("changed exact identity assignment");
  await runDialogueContextualQaComponent(cold.input);expect(cold.prepare).toHaveBeenCalledTimes(1);expect(cold.compile).toHaveBeenCalledTimes(1);
});

it("invalidates the empty result when the immutable source version changes",async()=>{
  const initial=emptyFixture();await runDialogueContextualQaComponent(initial.input);const cold=emptyFixture(initial.snapshot());
  const source=cold.sources[0]!,oldVersion=source.sourceVersionId;source.sourceVersionId="version.one.revised";source.contentHash=createHasher().digestHex("new source text");source.byteLength=15;
  cold.owners.set(source.sourceVersionId,{...cold.owners.get(oldVersion),sourceVersionId:source.sourceVersionId,contentHash:`sha256_${source.contentHash}`,byteLength:source.byteLength});
  await runDialogueContextualQaComponent(cold.input);expect(cold.prepare).toHaveBeenCalledTimes(1);expect(cold.compile).toHaveBeenCalledTimes(1);expect(cold.checkpoints.size).toBe(2);
});

it.each(["partial","missing-header","deferred"])("does not mark first empty computation complete after %s publication",async damage=>{
  const f=emptyFixture(),compile=f.input.compile;
  f.input.compile=vi.fn(async prepared=>{const result=await compile(prepared);
    if(damage==="partial")result.projections.pop();
    if(damage==="missing-header")f.projections.delete([...f.projections.keys()][0]!);
    return{...result,...(damage==="deferred"?{deferred:true}:{})};
  });
  expect(await runDialogueContextualQaComponent(f.input)).toEqual(f.report);
  expect([...f.checkpoints.values()][0]).toMatchObject({phase:"extracting",status:"running"});
  expect(f.writes.filter(value=>value==="checkpoint")).toHaveLength(1);
});
