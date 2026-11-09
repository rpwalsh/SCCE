// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { corpusSegmentationContextSliceDigest, type PreparedCorpusSegmentationMeasurement, type CorpusSegmentationContextSlice, boundaryContextKey, canonicalNormalizationContract, canonicalStringify, collectBoundaryTrainingObservations,
  compileBoundaryStatistics, createHasher, learnPagedSegmentationPopulations, measureSurfaceBoundaries, mergePagedBoundaryStatistics, toJsonValue,
  type BoundaryStatisticsCursor, type BoundaryStatisticsCursorHeader, type CorpusSegmentationDocument,
  type CorpusSegmentationDocumentCursor, type CompiledBoundaryFeatureContext, type JsonValue } from "@scce/kernel";
import type { PostgresStorageAdapter } from "./postgres.js";
import { PostgresCorpusSegmentationRun, createCorpusSegmentationRun, openCorpusSegmentationRun, activateCorpusSegmentationRun, readActiveCorpusSegmentationRun, corpusSegmentationScopeId, type CorpusSegmentationScope, type SegmentationPageBounds, segmentationOrdinalKey, sealCorpusSegmentationInputs, currentCorpusSegmentationDependency, snapshotCorpusSegmentationDependency } from "./corpus-segmentation-store.js";
import { CORPUS_SEGMENTATION_MIN_POOL_CONNECTIONS, withCorpusSegmentationLease } from "./corpus-segmentation-lease.js";
import { resolveCorpusSegmentationOwner } from "./corpus-segmentation-owner.js";
import { corpusSegmentationWindows } from "./corpus-segmentation-windows.js";

interface Owner {
  evidenceId: string; sourceId: string; sourceVersionId: string; textSha256: string; codePoints: number;
  sourceFamilyId: string; evidenceContentHash:string; byteStart: number; byteEnd: number; charStart: number; charEnd: number;
}
interface Window { documentId: string; sourceVersionId: string; ordinal: number; windowOrdinal: number; startUtf16: number; endUtf16: number; ownedStartUtf16: number; text: string }
const hash = (value: unknown) => createHash("sha256").update(canonicalStringify(value)).digest("hex");
export const CORPUS_SEGMENTATION_INPUT_RECIPE = "scce.corpus_segmentation_input.v1";
export function corpusSegmentationInputRecipe(windowUtf16: number): string {
  if (!Number.isSafeInteger(windowUtf16) || windowUtf16 < 2) throw new Error("Invalid segmentation Unicode window budget");
  return `${CORPUS_SEGMENTATION_INPUT_RECIPE}:${windowUtf16}`;
}
function owner(value: JsonValue): Owner {
  const row = value as unknown as Owner;
  if (!row || !row.evidenceId || !row.sourceId || !row.sourceVersionId || !row.sourceFamilyId
    || row.evidenceContentHash!==`sha256_${row.textSha256}` || !/^[a-f0-9]{64}$/u.test(row.textSha256) || !Number.isSafeInteger(row.codePoints) || row.codePoints < 0
    || [row.byteStart,row.byteEnd,row.charStart,row.charEnd].some(value => !Number.isSafeInteger(value) || value < 0)
    || row.byteEnd < row.byteStart || row.charEnd < row.charStart) throw new Error("Malformed corpus segmentation source ownership");
  return row;
}
async function* textChunks(storage: PostgresStorageAdapter, run: PostgresCorpusSegmentationRun, source: Owner, chunkCodePoints: number): AsyncGenerator<string> {
  const digest = createHash("sha256"); let offset = 0;
  while (offset < source.codePoints) {
    const evidenceAccess = storage.informationAccessPredicate("e", 5);
    const sourceAccess = storage.informationAccessPredicate("sv", 5 + evidenceAccess.params.length);
    const rows = await storage.query<{text: string}>(`SELECT substring(e.text_content FROM $3 FOR $4) AS text
      FROM ${storage.table("evidence_spans")} e JOIN ${storage.table("source_versions")} sv ON sv.id=e.source_version_id
      WHERE e.id=$1 AND sv.id=$2 AND e.status='promoted' AND ${evidenceAccess.sql} AND ${sourceAccess.sql}`,
      [source.evidenceId, source.sourceVersionId, offset + 1, chunkCodePoints, ...evidenceAccess.params, ...sourceAccess.params]);
    if (rows.length !== 1 || !rows[0]!.text) throw new Error("Owned corpus segmentation text changed or became inaccessible");
    const text = rows[0]!.text; offset += [...text].length;
    if (offset > source.codePoints) throw new Error("Corpus segmentation text length differs from its snapshot");
    digest.update(text, "utf8"); yield text;
  }
  if (digest.digest("hex") !== source.textSha256) throw new Error("Corpus segmentation text hash differs from its owned snapshot");
}
function windowValue(value: JsonValue): Window { return value as unknown as Window; }
function measured(window: Window) {
  return measureSurfaceBoundaries({ documentId: `corpus_window.${hash([window.documentId,window.sourceVersionId,window.startUtf16,window.endUtf16,window.text])}`, sourceVersionId: window.sourceVersionId as import("@scce/kernel").SourceVersionId, text: window.text, maxUnits: Number.MAX_SAFE_INTEGER });
}
async function counts(storage: PostgresStorageAdapter, run: PostgresCorpusSegmentationRun, collection: string, field: string, keys: readonly string[]): Promise<Record<string,number>> {
  const result: Record<string,number> = Object.create(null);
  let batch: Array<{key:string;prefix:string}>=[],bytes=2;
  const flush=async()=>{
    if(!batch.length)return;
    const access=storage.informationAccessPredicate("r",4);
    const rows=await storage.query<{key:string;count:string}>(`SELECT q.key,matched.count FROM jsonb_to_recordset($3::jsonb) q(key text,prefix text)
    CROSS JOIN LATERAL (SELECT COUNT(*)::text AS count FROM ${storage.table("segmentation_consolidation_rows")} v
      JOIN ${storage.table("segmentation_consolidation_runs")} r ON r.run_id=v.run_id
      WHERE v.run_id=$1 AND v.collection=$2 AND v.order_key COLLATE "C" >= q.prefix COLLATE "C"
        AND v.order_key COLLATE "C" < (q.prefix || '~') COLLATE "C" AND v.row_json->>'${field}'=q.key AND ${access.sql}) matched`,
      [run.run.runId,`input/${collection}`,JSON.stringify(batch),...access.params]);
    for(const row of rows){const count=Number(row.count);if(!Number.isSafeInteger(count)||count<0)throw new Error("Incomplete owned corpus boundary context");result[row.key]=count;}
    if(rows.length!==batch.length||batch.some(row=>result[row.key]===undefined))throw new Error("Incomplete owned corpus boundary context");
    batch=[];bytes=2;
  };
  for(const key of new Set(keys)){
    const row={key,prefix:`${hash(key)}:`},size=Buffer.byteLength(JSON.stringify(row))+1;
    if(size+2>run.bounds.maxPageBytes)throw new Error("Corpus boundary context key exceeds decoded JSON budget");
    if(batch.length&&(batch.length>=run.bounds.pageRows||bytes+size>run.bounds.maxPageBytes))await flush();
    batch.push(row);bytes+=size;
  }
  await flush();return result;
}

/** All promoted owned documents, every original Unicode position; only bounded windows enter the existing compiler. */
export async function prepareCorpusSegmentationInput(input: { storage: PostgresStorageAdapter; run: PostgresCorpusSegmentationRun; windowUtf16: number; signal?:AbortSignal;
  onProgress?:(progress:{phase:"collecting-context"|"compiling-statistics";completedOwners:number;documentCount:number;windowCount:number;coveredUtf16:number})=>void|Promise<void> }): Promise<CorpusSegmentationDocumentCursor & { featureContextId: string }> {
  const { storage, run, windowUtf16 } = input, hasher = createHasher();
  if (run.run.recipeId !== corpusSegmentationInputRecipe(windowUtf16) || run.run.normalizationContractId !== canonicalNormalizationContract(hasher).id) throw new Error("Corpus segmentation producer recipe or normalization mismatch");
  await run.assertState("building");
  const inventory = await run.digest("input/inventory");
  let documentCount = 0, windowCount = 0, coveredUtf16 = 0;
  const checkAbort=()=>{if(input.signal?.aborted)throw input.signal.reason??new Error("Corpus segmentation preparation aborted by owner");};
  const cached=async(collection:string,orderKey:string)=>{for await(const page of run.pages(collection,{prefix:orderKey,pageRows:1})){
    if(page[0]!.orderKey!==orderKey)throw new Error("Malformed corpus segmentation preparation cursor");return page[0]!.value;
  }return null;};
  // First pass: exact distinct owner/class and context/class pairs, never window-as-document counts.
  for await (const page of run.pages("input/inventory")) for (const row of page) {
    checkAbort();
    const source = owner(row.value), ordinal = ++documentCount, docKey = segmentationOrdinalKey(ordinal);
    const previous=await cached("input/owners",docKey) as (Owner&{completeUnicodeCoverage?:boolean;windowCount:number;utf16Length:number})|null;
    if(previous){
      if(previous.evidenceId!==source.evidenceId||previous.sourceVersionId!==source.sourceVersionId||previous.textSha256!==source.textSha256
        ||previous.completeUnicodeCoverage!==true||!Number.isSafeInteger(previous.windowCount)||previous.windowCount<0
        ||!Number.isSafeInteger(previous.utf16Length)||previous.utf16Length<0)throw new Error("Invalid completed corpus segmentation owner cursor");
      windowCount+=previous.windowCount;coveredUtf16+=previous.utf16Length;
      await input.onProgress?.({phase:"collecting-context",completedOwners:documentCount,documentCount:inventory.count,windowCount,coveredUtf16});continue;
    }
    source.sourceFamilyId=await resolveCorpusSegmentationOwner(storage,run,source.sourceVersionId,source.sourceId,input.signal);
    let windowOrdinal = 0, previousEnd = 0;
    for await (const part of corpusSegmentationWindows(textChunks(storage, run, source, Math.max(1,Math.floor(windowUtf16 / 2))), windowUtf16)) {
      checkAbort();
      if (part.ownedStartUtf16 !== previousEnd || part.startUtf16 > part.ownedStartUtf16 || part.endUtf16 <= previousEnd) throw new Error("Incomplete corpus segmentation Unicode coverage");
      const window: Window = { ...part, documentId: source.evidenceId, sourceVersionId: source.sourceVersionId, ordinal, windowOrdinal: ++windowOrdinal };
      await run.scratch.putMany("producer/windows", [{ orderKey: `${docKey}:${segmentationOrdinalKey(windowOrdinal)}`, value: toJsonValue(window) }]);
      const {text: windowText,...coverage} = window;
      await run.putInput("coverage", [{orderKey: `${docKey}:${segmentationOrdinalKey(windowOrdinal)}`, value: toJsonValue({...coverage,textSha256: createHash("sha256").update(windowText,"utf8").digest("hex")})}]);
      const lattice = measured(window), pairs = new Map<string,JsonValue>(), contexts = new Map<string,JsonValue>();
      for (const unit of lattice.units) if (unit.overlapClass !== "base_partition") {
        const classId = unit.surfaceFormClassId, contextKey = boundaryContextKey(unit);
        pairs.set(`${hash(classId)}:${hash(source.evidenceId)}`, toJsonValue({ surfaceFormClassId: classId, documentId: source.evidenceId }));
        contexts.set(`${hash(contextKey)}:${hash(classId)}`, toJsonValue({ contextKey, surfaceFormClassId: classId }));
      }
      await run.putInput("class-documents", [...pairs].map(([orderKey,value]) => ({orderKey,value})));
      await run.putInput("context-classes", [...contexts].map(([orderKey,value]) => ({orderKey,value})));
      coveredUtf16 += part.endUtf16 - previousEnd; previousEnd = part.endUtf16; windowCount++;
    }
    await run.putInput("owners", [{orderKey: docKey, value: toJsonValue({ ...source, ordinal, completeUnicodeCoverage:true, windowCount: windowOrdinal, utf16Length: previousEnd })}]);
    await input.onProgress?.({phase:"collecting-context",completedOwners:documentCount,documentCount:inventory.count,windowCount,coveredUtf16});
  }
  checkAbort();
  if (documentCount !== inventory.count) throw new Error("Corpus segmentation owner inventory is incomplete");
  const dependency=await snapshotCorpusSegmentationDependency(run);
  const populationId = `surface_population.${hash([dependency,run.run.recipeId,run.run.normalizationContractId]).slice(0,32)}`;
  const classDigest = await run.digest("input/class-documents"), contextDigest = await run.digest("input/context-classes");
  const featureContextId = `boundary_feature_context.${hash([dependency,classDigest,contextDigest]).slice(0,40)}`;
  // Second pass: compile each window with exact whole-snapshot counts, then merge into one owned document.
  for await (const page of run.pages("input/owners")) for (const row of page) {
    checkAbort();
    const source = owner(row.value), ordinal = Number((row.value as Record<string,JsonValue>).ordinal), docKey = segmentationOrdinalKey(ordinal);
    const previous=await cached("input/documents",docKey) as unknown as CorpusSegmentationDocument|null;
    if(previous){
      if(previous.documentId!==source.evidenceId||previous.sourceFamilyId!==source.sourceFamilyId||previous.statistics.populationId!==populationId)throw new Error("Invalid completed corpus segmentation statistics cursor");
      await input.onProgress?.({phase:"compiling-statistics",completedOwners:ordinal,documentCount,windowCount,coveredUtf16});continue;
    }
    const sources = async function* (): AsyncGenerator<BoundaryStatisticsCursor> {
      let windowsObserved = 0;
      for await (const windows of run.scratch.pages({collection: "producer/windows", prefix: `${docKey}:`, ...run.bounds})) for (const windowRow of windows) {
        checkAbort();
        windowsObserved++;
        const window = windowValue(windowRow.value), lattice = measured(window), hypotheses = lattice.units.filter(unit => unit.overlapClass !== "base_partition");
        const context: CompiledBoundaryFeatureContext = { schema: "scce.boundary_feature_context.v1", id: featureContextId, sourceDocumentCount: documentCount,
          documentCountBySurfaceFormClass: await counts(storage, run, "class-documents", "surfaceFormClassId", hypotheses.map(unit => unit.surfaceFormClassId)),
          classCountByBoundaryContext: await counts(storage, run, "context-classes", "contextKey", hypotheses.map(boundaryContextKey)) };
        const statistics = compileBoundaryStatistics({ populationId, normalizationContractId: run.run.normalizationContractId,
          observations: collectBoundaryTrainingObservations({ lattices: [lattice], featureContext: context }).map(observation => ({...observation,sourceDocumentId:source.evidenceId})), sourceDocumentIds: [source.evidenceId], hasher });
        const { rows, sourceDocumentIds, ...header } = statistics;
        yield { header: { ...header, rowCount: rows.length, sourceInventory: {id: hash(sourceDocumentIds),count: sourceDocumentIds.length}},
          rows: async function* () { for (let start=0;start<rows.length;start+=run.bounds.pageRows) yield rows.slice(start,start+run.bounds.pageRows); },
          sourceDocuments: async function* () { yield sourceDocumentIds; } };
      }
      if (!windowsObserved) {
        const {rows,sourceDocumentIds,...header} = compileBoundaryStatistics({populationId,normalizationContractId:run.run.normalizationContractId,observations:[],sourceDocumentIds:[source.evidenceId],hasher});
        yield {header:{...header,rowCount:0,sourceInventory:{id:hash(sourceDocumentIds),count:1}}, rows:async function*(){yield rows;},sourceDocuments:async function*(){yield sourceDocumentIds;}};
      }
    };
    const merged = await mergePagedBoundaryStatistics({ sources, scratch: run.scratch, populationId, collectionPrefix: "producer/document", hasher });
    let rowOrdinal = 0;
    for await (const rows of merged.rows()) await run.putInput(`statistics/${docKey}`, rows.map(value => ({orderKey: segmentationOrdinalKey(++rowOrdinal),value: toJsonValue(value)})));
    const document: CorpusSegmentationDocument = {ordinal,documentId: source.evidenceId,sourceFamilyId: source.sourceFamilyId,statistics: merged.header};
    await run.putInput("documents", [{orderKey: docKey,value: toJsonValue(document)}]);
    await merged.dispose?.();
    await input.onProgress?.({phase:"compiling-statistics",completedOwners:ordinal,documentCount,windowCount,coveredUtf16});
  }
  for (const collection of ["producer/windows"]) await run.scratch.deleteCollection(collection);
  await sealCorpusSegmentationInputs(storage, run, toJsonValue({ completeUnicodeCoverage: true, dependency, documentCount, windowCount, coveredUtf16, featureContextId, normalizationContractId: run.run.normalizationContractId }));
  return corpusSegmentationDocumentCursor(run, {documentCount,sourceInventory:dependency,featureContextId});
}

export function corpusSegmentationDocumentCursor(run: PostgresCorpusSegmentationRun, snapshot: {documentCount: number; sourceInventory: {id: string;count: number};featureContextId: string}): CorpusSegmentationDocumentCursor & {featureContextId: string} {
  return { ...snapshot, scratch: run.scratch,
    documents: async function* () { for await (const page of run.pages("input/documents")) yield page.map(row => row.value as unknown as CorpusSegmentationDocument); },
    statistics: document => ({ header: document.statistics,
      rows: async function* () { for await (const page of run.pages(`input/statistics/${segmentationOrdinalKey(document.ordinal)}`)) yield page.map(row => row.value as unknown as import("@scce/kernel").BoundaryStatisticsRow); },
      sourceDocuments: async function* () { yield [document.documentId]; } }) };
}


export async function restoreCorpusSegmentationInput(storage: PostgresStorageAdapter, run: PostgresCorpusSegmentationRun): Promise<CorpusSegmentationDocumentCursor & {featureContextId:string}> {
  const access=storage.informationAccessPredicate("r",2);
  const rows=await storage.query<{snapshot_json:{dependency:{id:string;count:number};snapshot:{documentCount:number;featureContextId:string;completeUnicodeCoverage:boolean}}}>(`SELECT r.snapshot_json FROM ${storage.table("segmentation_consolidation_runs")} r WHERE r.run_id=$1 AND r.state IN ('fitting','complete') AND ${access.sql}`,[run.run.runId,...access.params]);
  const record=rows[0]?.snapshot_json;
  if(!record||!record.snapshot.completeUnicodeCoverage||record.snapshot.documentCount!==record.dependency.count
    ||await run.count("input/documents")!==record.snapshot.documentCount)throw new Error("Incomplete corpus segmentation input snapshot");
  const current=await currentCorpusSegmentationDependency(storage,run);
  if(canonicalStringify(current)!==canonicalStringify(record.dependency))throw new Error("Corpus segmentation source dependencies changed before restore");
  return corpusSegmentationDocumentCursor(run,{documentCount:record.snapshot.documentCount,sourceInventory:record.dependency,featureContextId:record.snapshot.featureContextId});
}


/** A complete bounded lookup for ONE opaque prepared window; absence is explicit zero, never an omitted key. */
export async function loadCorpusSegmentationContextSlice(input:{storage:PostgresStorageAdapter;run:PostgresCorpusSegmentationRun;measurement:PreparedCorpusSegmentationMeasurement;
  expected:{id:string;sourceInventory:{id:string;count:number};featureContextId:string;normalizationContractId:string}}):Promise<CorpusSegmentationContextSlice>{
  const {storage,run,measurement}=input;
  const expected={id:input.expected.id,sourceInventory:{...input.expected.sourceInventory},featureContextId:input.expected.featureContextId,normalizationContractId:input.expected.normalizationContractId};
  const access=storage.informationAccessPredicate("r",3);
  const rows=await storage.query<{snapshot_json:{dependency:{id:string;count:number};snapshot:{featureContextId:string;completeUnicodeCoverage:boolean}}}>(`
    SELECT r.snapshot_json FROM ${storage.table("segmentation_consolidation_runs")} r
    JOIN ${storage.table("segmentation_consolidation_active")} a ON a.run_id=r.run_id AND a.scope_id=r.scope_id AND a.header_json=r.inference_json
    WHERE r.run_id=$1 AND r.state='complete' AND r.inference_json->>'id'=$2 AND ${access.sql}`,[run.run.runId,expected.id,...access.params]);
  const snapshot=rows[0]?.snapshot_json;
  if(!snapshot?.snapshot.completeUnicodeCoverage||snapshot.snapshot.featureContextId!==expected.featureContextId
    ||expected.normalizationContractId!==run.run.normalizationContractId||canonicalStringify(snapshot.dependency)!==canonicalStringify(expected.sourceInventory))throw new Error("Corpus segmentation context slice snapshot does not match inference");
  const featureContext:CompiledBoundaryFeatureContext={schema:"scce.boundary_feature_context.v1",id:expected.featureContextId,sourceDocumentCount:expected.sourceInventory.count,
    documentCountBySurfaceFormClass:await counts(storage,run,"class-documents","surfaceFormClassId",measurement.requiredClassIds),
    classCountByBoundaryContext:await counts(storage,run,"context-classes","contextKey",measurement.requiredContextKeys)};
  const binding={measurementId:measurement.id,snapshotId:expected.sourceInventory.id,sourceInventory:expected.sourceInventory,
    contextId:expected.featureContextId,normalizationContractId:expected.normalizationContractId};
  return {featureContext,binding:{...binding,valueDigest:corpusSegmentationContextSliceDigest({featureContext,binding})}};
}


/** One canonical create/resume ? complete owned statistics ? exact fit ? atomic publication workflow. */
async function consolidateCorpusSegmentationOwned(input:{storage:PostgresStorageAdapter;scope:CorpusSegmentationScope;runId:string;createdAt:number;bounds:SegmentationPageBounds;windowUtf16:number;
  resume?:boolean;signal?:AbortSignal;onProgress?:Parameters<typeof prepareCorpusSegmentationInput>[0]["onProgress"];
  maxPopulations?:number;mergeDescriptionMarginNats?:number;heldoutRegressionToleranceNats?:number}){
  const {storage}=input,recipeId=corpusSegmentationInputRecipe(input.windowUtf16),normalizationContractId=canonicalNormalizationContract(createHasher()).id;
  const fitPolicy={maxPopulations:input.maxPopulations??null,mergeDescriptionMarginNats:input.mergeDescriptionMarginNats??null,heldoutRegressionToleranceNats:input.heldoutRegressionToleranceNats??null};
  if(Object.values(fitPolicy).some(value=>value!==null&&!Number.isFinite(value)))throw new Error("Invalid corpus segmentation fit policy");
  const run=input.resume?await openCorpusSegmentationRun(storage,input.runId,input.bounds):await createCorpusSegmentationRun(storage,{
    runId:input.runId,scopeId:corpusSegmentationScopeId(input.scope),scope:input.scope,recipeId,normalizationContractId,createdAt:input.createdAt,fitPolicy},input.bounds);
  if(run.run.scopeId!==corpusSegmentationScopeId(input.scope)||run.run.recipeId!==recipeId||run.run.normalizationContractId!==normalizationContractId||canonicalStringify(run.run.fitPolicy??null)!==canonicalStringify(fitPolicy))throw new Error("Corpus segmentation resume declaration differs");
  const state=await run.state();
  if(state==="complete"){
    const active=await readActiveCorpusSegmentationRun(storage,input.scope,{recipeId,normalizationContractId},input.bounds);
    if(!active||active.run.run.runId!==run.run.runId)throw new Error("Completed corpus segmentation run is not the active scoped snapshot");
    return {runId:run.run.runId,alreadyComplete:true,minimumPoolConnections:CORPUS_SEGMENTATION_MIN_POOL_CONNECTIONS,model:active.inference};
  }
  if(state==="failed")throw new Error("Failed corpus segmentation run requires a new explicit run identity");
  const source=state==="building"?await prepareCorpusSegmentationInput({storage,run,windowUtf16:input.windowUtf16,signal:input.signal,onProgress:input.onProgress}):await restoreCorpusSegmentationInput(storage,run);
  if(input.signal?.aborted)throw input.signal.reason??new Error("Corpus segmentation fit aborted by owner");
  let rootPopulationId:string|undefined;
  for await(const page of source.documents()){rootPopulationId=page[0]?.statistics.populationId;if(rootPopulationId)break;}
  if(!rootPopulationId)throw new Error("Corpus segmentation has no complete owned document statistics");
  const check=()=>{if(input.signal?.aborted)throw input.signal.reason??new Error("Corpus segmentation fit aborted by owner");};
  const guarded:CorpusSegmentationDocumentCursor=input.signal?{...source,
    documents:async function*(){for await(const page of source.documents()){check();yield page;}},
    statistics:document=>{const original=source.statistics(document);return {...original,
      rows:async function*(){for await(const page of original.rows()){check();yield page;}},
      sourceDocuments:async function*(){for await(const page of original.sourceDocuments()){check();yield page;}}};},
    scratch:{...source.scratch,
      pages:async function*(query){for await(const page of source.scratch.pages(query)){check();yield page;}},
      putMany:async(collection,rows)=>{check();await source.scratch.putMany(collection,rows);}}
  }:source;
  const fitted=await learnPagedSegmentationPopulations({rootPopulationId,source:guarded,namespace:"fit",featureContextId:source.featureContextId,
    maxPopulations:input.maxPopulations,mergeDescriptionMarginNats:input.mergeDescriptionMarginNats,heldoutRegressionToleranceNats:input.heldoutRegressionToleranceNats});
  if(input.signal?.aborted)throw input.signal.reason??new Error("Corpus segmentation publication aborted by owner");
  await activateCorpusSegmentationRun(storage,run,fitted.model);
  return {runId:run.run.runId,alreadyComplete:false,minimumPoolConnections:CORPUS_SEGMENTATION_MIN_POOL_CONNECTIONS,model:fitted.model};
}


type ConsolidationInput=Parameters<typeof consolidateCorpusSegmentationOwned>[0];
type ConsolidationResult=Awaited<ReturnType<typeof consolidateCorpusSegmentationOwned>>;
const consolidationFlights=new WeakMap<PostgresStorageAdapter,Map<string,{signature:string;promise:Promise<ConsolidationResult>}>>();
export function consolidateCorpusSegmentation(input:ConsolidationInput):Promise<ConsolidationResult>{
  if(input.signal?.aborted)return Promise.reject(input.signal.reason??new Error("Corpus segmentation consolidation aborted"));
  let flights=consolidationFlights.get(input.storage);if(!flights){flights=new Map();consolidationFlights.set(input.storage,flights);}
  const signature=hash({scope:input.scope,bounds:input.bounds,windowUtf16:input.windowUtf16,maxPopulations:input.maxPopulations??null,
    mergeDescriptionMarginNats:input.mergeDescriptionMarginNats??null,heldoutRegressionToleranceNats:input.heldoutRegressionToleranceNats??null});
  const existing=flights.get(input.runId);
  if(existing){if(existing.signature!==signature)return Promise.reject(new Error("In-flight corpus segmentation run declaration differs"));return existing.promise;}
  const ownedFlights=flights;
  const promise=(async()=>{try{return await withCorpusSegmentationLease(input.storage.pool,input.storage.schema,input.runId,()=>consolidateCorpusSegmentationOwned(input));}
    finally{ownedFlights.delete(input.runId);}})();
  flights.set(input.runId,{signature,promise});return promise;
}
