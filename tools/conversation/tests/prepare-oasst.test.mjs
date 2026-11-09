import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, open, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { prepareOasst } from '../prepare-oasst.mjs';
import { fileHash } from '../../blind-comparison/protocol.mjs';
import { sha256Text, sha256Bytes, stableStringify } from '../../sealed-eval/harness/lib/util.mjs';
import { validateDeclaredTranscriptSource } from '../../../packages/kernel/dist/dialogue-communicative-act-learning.js';
const roots = [];
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
function message(id, parent, role, text, extra = {}) { return { message_id: id, parent_id: parent, message_tree_id: 'r1', role, lang: 'ca', text, review_result: true, review_count: 2, deleted: false, synthetic: false, model_name: null, ...extra }; }
async function fixture(rows, source = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'scce-oasst-prepare-')); roots.push(root);
  const archive = path.join(root, 'source.messages.jsonl.gz');
  const bytes = gzipSync(source.bytes ?? (rows.map(row => JSON.stringify(row)).join('\n') + '\n'));
  await writeFile(archive, bytes); await writeFile(path.join(root, 'LICENSE'), source.licenseBytes ?? 'Pinned fixture license, source metadata only.\n');
  await writeFile(path.join(root, 'capture.json'), JSON.stringify({ schema: 'scce.captured_source.v1', dataset: 'OpenAssistant/oasst1', revision: source.provenance?.source.revision ?? 'a'.repeat(40), file: path.basename(archive), sha256: await fileHash(archive), bytes: bytes.length,
    license: source.provenance?.source.license ?? 'fixture-license', url: source.provenance?.source.url ?? 'https://example.invalid/pinned-human-source',
    ...(source.provenance ? { preparation: { kind: 'exact_public_release_subset', sourceArchiveSha256: source.provenance.source.archiveSha256, sourceFixtureSha256: source.provenance.fixture.sha256 } } : {}) }));
  return { root, archive, out: path.join(root, 'prepared'), limits: { ca: 128 } };
}
async function documents(report, out) { return Promise.all(report.documents.map(async row => JSON.parse(await readFile(path.join(out, row.relativePath), 'utf8')))); }
test('root pairs preserve exact Unicode source/NFC spans, declared reply edges, flags and licensed lineage without fabricated authority', async () => {
  const rows = [message('r1', null, 'prompter', 'Qüestió 👋 amb accent.'), message('a1', 'r1', 'assistant', 'Resposta e\u0301 amb detall.'), message('a2', 'r1', 'assistant', 'Una altra branca.'), message('r2', 'a1', 'prompter', 'Segueix el fil.'), message('a3', 'r2', 'assistant', 'Continuació real.')];
  const config = await fixture(rows), report = await prepareOasst(config), [doc] = await documents(report, config.out);
  assert.equal(report.locales.ca.availableRoots, 1);
  assert.equal(report.locales.ca.verifiedCandidatePaths, 2);
  assert.equal(report.locales.ca.retainedDocuments, 1);
  assert.equal(doc.turns.length, 2);
  assert.equal(doc.turns[1].replyToTurnIndex, 0);
  assert.equal(doc.turns[1].commitmentScope, 'conversation');
  assert.ok(doc.turns.every(turn => !Object.hasOwn(turn, 'requestAuthority') && !Object.hasOwn(turn, 'supportingSourceRanges')));
  assert.equal(doc.text, doc.text.normalize('NFC'));
  for (const turn of doc.turns) assert.equal([...doc.text].slice(turn.startCodePoint, turn.endCodePoint).join(''), turn.surface);
  for (const row of doc.sourceMetadata.lineage) {
    const original = rows.find(value => value.message_id === row.id);
    assert.equal(row.originalTextSha256, sha256Text(original.text));
    assert.equal(row.nfcTextSha256, sha256Text(original.text.normalize('NFC')));
    assert.equal(row.sourceFlags.synthetic, false);
    assert.equal(row.sourceFlags.review_result, true);
    assert.equal(row.sourceFlags.model_name, null);
  }
  assert.equal((await readdir(config.out)).includes('.source-preparation-index'), false);
});
test('paths include only verified actual ancestor chains and never concatenate sibling branches or unrelated pairs', async () => {
  const rows = [message('r1', null, 'prompter', 'Original request'), message('a1', 'r1', 'assistant', 'First branch'), message('a2', 'r1', 'assistant', 'Sibling branch'), message('r2', 'a1', 'prompter', 'Real followup'), message('a3', 'r2', 'assistant', 'Real continuation'), message('foreign', null, 'prompter', 'Separate root', { message_tree_id: 'foreign' }), message('foreign-a', 'foreign', 'assistant', 'Separate reply', { message_tree_id: 'foreign' })];
  const config = await fixture(rows), report = await prepareOasst({ ...config, mode: 'paths' });
  for (const doc of await documents(report, config.out)) {
    const ids = doc.sourceMetadata.lineage.map(row => row.id);
    for (let i = 1; i < ids.length; i++) assert.equal(rows.find(row => row.message_id === ids[i]).parent_id, ids[i - 1]);
    assert.equal(ids.includes('a1') && ids.includes('a2'), false);
    assert.ok(ids.every(id => rows.find(row => row.message_id === id).message_tree_id === doc.sourceMetadata.rootMessageId));
  }
});
test('human/review/model/deletion filters retain rejection counts and cannot manufacture missing ancestors', async () => {
  const rows = [message('r1', null, 'prompter', 'Kept request'), message('good', 'r1', 'assistant', 'Kept reply'), message('model', 'r1', 'assistant', 'Model reply', { model_name: 'generator' }), message('synthetic', 'r1', 'assistant', 'Synthetic reply', { synthetic: true }), message('deleted', 'r1', 'assistant', 'Deleted reply', { deleted: true }), message('unreviewed', 'r1', 'assistant', 'Unreviewed reply', { review_result: false }), message('orphan', 'missing', 'assistant', 'No ancestor'), message('other-lang', 'r1', 'assistant', 'Different locale', { lang: 'es' })];
  const config = await fixture(rows), report = await prepareOasst(config), [doc] = await documents(report, config.out);
  assert.equal(doc.sourceMetadata.replyMessageId, 'good');
  assert.equal(report.locales.ca.sourceRejections.synthetic_model_or_unspecified, 2);
  assert.equal(report.locales.ca.sourceRejections.deleted_or_unspecified, 1);
  assert.equal(report.locales.ca.sourceRejections.not_source_reviewed, 1);
  assert.equal(report.locales.ca.pathRejections.missing_eligible_ancestor, 1);
});
test('hash-order selection is deterministic, one branch per source root, and bounded by explicit locale limits', async () => {
  const rows = [];
  for (let n = 0; n < 12; n++) {
    const id = `r${n}`;
    rows.push(message(id, null, 'prompter', `Request ${n}`, { message_tree_id: id }), message(`${id}-a`, id, 'assistant', `Reply ${n}`, { message_tree_id: id }), message(`${id}-b`, id, 'assistant', `Sibling ${n}`, { message_tree_id: id }));
  }
  const config = await fixture(rows), a = await prepareOasst({ ...config, limits: { ca: 3 } });
  const b = await prepareOasst({ ...config, out: path.join(config.root, 'second'), limits: { ca: 3 } });
  assert.deepEqual(a.documents, b.documents);
  assert.equal(a.locales.ca.availableRoots, 12);
  assert.equal(a.locales.ca.retainedDocuments, 3);
  assert.equal(new Set(a.documents.map(row => row.rootMessageId)).size, 3);
});
test('pinned archive tampering and duplicate message identities fail before any training can be invoked', async () => {
  const config = await fixture([message('r1', null, 'prompter', 'Request'), message('a1', 'r1', 'assistant', 'Reply')]);
  await writeFile(config.archive, gzipSync('tampered source\n'));
  await assert.rejects(() => prepareOasst(config), /pinned capture/);
  const duplicate = await fixture([message('r1', null, 'prompter', 'Request'), message('r1', null, 'prompter', 'Other request')]);
  await assert.rejects(() => prepareOasst(duplicate), /Duplicate source message/);
});

function unpack(document) {
  if (!document.sourceMetadata.packing) return [document];
  const { packing, conversations, lineage, ...shared } = document.sourceMetadata;
  return conversations.map(conversation => {
    const [first,last] = conversation.turnRange, [start,end] = conversation.textRange;
    const decoded = { schema: document.schema, text: [...document.text].slice(start,end).join(''),
      turns: document.turns.slice(first,last).map(turn => {
        const { sourceRecordId,sourceFamilyId,...original } = turn;
        return {...original,index:turn.index-first,startCodePoint:turn.startCodePoint-start,endCodePoint:turn.endCodePoint-start,
          ...(turn.replyToTurnIndex===undefined?{}:{replyToTurnIndex:turn.replyToTurnIndex-first})};
      }),
      sourceMetadata: {...shared,rootMessageId:conversation.rootMessageId,replyMessageId:conversation.replyMessageId,
        lineage:lineage.slice(first,last).map(row=>{
          const {preparedDocumentCodePointRange,rawSourceMetadata,...original}=row;
          assert.deepEqual(row.normalizedDocumentCodePointRange.map(point=>point-start),preparedDocumentCodePointRange);
          return {...original,normalizedDocumentCodePointRange:preparedDocumentCodePointRange};
        })} };
    validateDeclaredTranscriptSource(decoded);
    assert.equal(sha256Text(`${stableStringify(decoded)}\n`),conversation.transcriptSha256);
    return decoded;
  });
}
function ordered(rows){return [...rows].sort((a,b)=>a.sourceMetadata.rootMessageId.localeCompare(b.sourceMetadata.rootMessageId));}
async function noSpool(config) {
  assert.equal((await readdir(config.out)).includes('.source-preparation-index'),false);
}

test('packs genuine public reviewed OASST roots with exact decoded lineage and reply parity across byte bounds', async()=>{
  const fixtureRoot=new URL('./fixtures/',import.meta.url),bytes=await readFile(new URL('oasst-public-reviewed-messages.jsonl',fixtureRoot));
  const provenance=JSON.parse(await readFile(new URL('oasst-public-reviewed-provenance.json',fixtureRoot),'utf8'));
  assert.equal(sha256Bytes(bytes),provenance.fixture.sha256);
  const rows=bytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  assert.equal(rows.length,24);
  for(const [index,line]of bytes.toString('utf8').trimEnd().split('\n').entries()){
    assert.equal(rows[index].message_id,provenance.messages[index].messageId);
    assert.equal(sha256Text(line),provenance.messages[index].rawLineSha256);
  }
  const config=await fixture(rows,{bytes,provenance,licenseBytes:await readFile(new URL('OASST1-LICENSE.txt',fixtureRoot))});config.limits={en:3,ru:3,es:3,ca:3};
  const plain=await prepareOasst(config),original=await documents(plain,config.out);assert.equal(plain.documents.length,12);
  const packedConfig={...config,out:path.join(config.root,'packed'),packing:{maxSerializedBytes:262144,maxTextBytes:65536}};
  const packed=await prepareOasst(packedConfig),packedDocs=await documents(packed,packedConfig.out);
  assert.equal(packed.documents.length,4,'One bounded transcript per locale replaces the twelve individual path files');
  assert.deepEqual(ordered(packedDocs.flatMap(unpack)),ordered(original));
  const tightConfig={...packedConfig,out:path.join(config.root,'tight'),packing:{maxSerializedBytes:32768,maxTextBytes:2650}};
  const tight=await prepareOasst(tightConfig),tightDocs=await documents(tight,tightConfig.out);
  assert.ok(tight.documents.length>packed.documents.length);assert.deepEqual(ordered(tightDocs.flatMap(unpack)),ordered(original));
  for(const [report,root,declaration]of [[packed,packedConfig.out,packedConfig.packing],[tight,tightConfig.out,tightConfig.packing]]){
    assert.equal(report.locales.en.retainedDocuments,3);assert.equal(report.resources.spoolFilesCreated,1);
    assert.ok(report.serializedIndexBytes<=report.limits.maxSerializedIndexBytes);
    for(const row of report.documents){
      const raw=await readFile(path.join(root,row.relativePath)),doc=validateDeclaredTranscriptSource(JSON.parse(raw));
      assert.ok(raw.length<=declaration.maxSerializedBytes);assert.ok(Buffer.byteLength(doc.text)<=declaration.maxTextBytes);
      assert.equal(await fileHash(path.join(root,row.relativePath)),row.sha256);
      assert.deepEqual(doc.sourceMetadata.archiveSha256,packed.source.archiveSha256);
      for(const entry of doc.sourceMetadata.lineage){const source=rows.find(value=>value.message_id===entry.id),{text,...metadata}=source;
        assert.deepEqual(entry.rawSourceMetadata,metadata);assert.equal(entry.originalTextSha256,sha256Text(text));
        assert.equal(entry.sourceFlags.synthetic,false);assert.equal(entry.sourceFlags.review_result,true);
      }
      for(const conversation of doc.sourceMetadata.conversations){
        const [first,last]=conversation.turnRange;assert.equal(doc.turns[first].replyToTurnIndex,undefined);
        for(let i=first;i<last;i++){assert.equal(doc.turns[i].sourceFamilyId,conversation.rootMessageId);assert.equal(doc.turns[i].sourceRecordId,doc.sourceMetadata.lineage[i].id);if(i>first)assert.equal(doc.turns[i].replyToTurnIndex,i-1);}
      }
      assert.ok(doc.turns.every(turn=>!Object.hasOwn(turn,'requestAuthority')&&!Object.hasOwn(turn,'supportingSourceRanges')));
    }
    for(const training of report.training)assert.equal(training.expectedDocuments,report.documents.filter(row=>row.locale===training.locale).length);
  }
  for(const doc of original)validateDeclaredTranscriptSource(doc);
  await noSpool(config);await noSpool(packedConfig);await noSpool(tightConfig);
});

test('uses one actual bounded indexed record spool rather than a file per selected message',async()=>{
  const rows=[];
  for(let n=0;n<300;n++){const id=`root${n}`;rows.push(message(id,null,'prompter',`opaque ${n}`,{message_tree_id:id}),message(`${id}-a`,id,'assistant',`reply ${n}`,{message_tree_id:id}));}
  const config=await fixture(rows),observed=[];
  const maxSpoolBytes=rows.reduce((sum,row)=>sum+Buffer.byteLength(JSON.stringify(row)),0);
  const report=await prepareOasst({...config,limits:{ca:300},maxSpoolBytes,maxIndexBytes:1024*1024,packing:{maxSerializedBytes:32768,maxTextBytes:65536},
    onProgress:async progress=>{observed.push(progress.stage);assert.deepEqual(await readdir(path.dirname(progress.path)),['records.bin']);if(progress.stage==='spool.complete')assert.equal((await stat(progress.path)).size,progress.bytes);}});
  assert.deepEqual(observed,['spool.opened','spool.complete']);assert.equal(report.resources.spooledRecords,600);assert.equal(report.resources.spoolBytes,maxSpoolBytes);
  assert.equal(report.locales.ca.retainedDocuments,300);assert.ok(report.documents.length<300);
  for(const doc of await documents(report,config.out))validateDeclaredTranscriptSource(doc);
  await noSpool(config);
});

test('spool, packing and metadata overflow refuse completion and release their owned file',async()=>{
  const base=await fixture([message('r1',null,'prompter','request'),message('a1','r1','assistant','reply')]);
  for(const [name,options,error]of [
    ['spool',{maxSpoolBytes:1},/spool exceeds/],['index',{maxIndexBytes:1},/metadata index exceeds/],
    ['packing',{packing:{maxSerializedBytes:128,maxTextBytes:65536}},/packing bounds/],
    ['packing-envelope',{packing:{maxSerializedBytes:1024,maxTextBytes:65536}},/packing bounds/]
  ]){const config={...base,...options,out:path.join(base.root,name)};await assert.rejects(prepareOasst(config),error);await noSpool(config);await assert.rejects(readFile(path.join(config.out,'preparation.json')),/ENOENT/);}
  for(const packing of [{maxSerializedBytes:0,maxTextBytes:65536},{maxSerializedBytes:65536},{maxSerializedBytes:65536,maxTextBytes:Infinity}])await assert.rejects(prepareOasst({...base,packing}),/positive/);
  const valid=await prepareOasst(base);assert.ok(valid.resources.spoolIndexBytes>0);
  const indexed={...base,out:path.join(base.root,'locator-index'),maxIndexBytes:valid.serializedIndexBytes-valid.resources.spoolIndexBytes};
  await assert.rejects(prepareOasst(indexed),/metadata index exceeds/);await noSpool(indexed);
});

test('cancellation and callback errors close and unlink the one owned spool without a completed receipt',async()=>{
  for(const stage of ['spool.opened','spool.complete']){
    const config=await fixture([message('r1',null,'prompter','request'),message('a1','r1','assistant','reply')]),controller=new AbortController();
    await assert.rejects(prepareOasst({...config,signal:controller.signal,onProgress:progress=>{if(progress.stage===stage)controller.abort();}}),error=>error.name==='AbortError');
    await noSpool(config);await assert.rejects(readFile(path.join(config.out,'preparation.json')),/ENOENT/);
  }
  const config=await fixture([message('r1',null,'prompter','request'),message('a1','r1','assistant','reply')]),failure=Error('observer stopped');
  await assert.rejects(prepareOasst({...config,onProgress:progress=>{if(progress.stage==='spool.complete')throw failure;}}),error=>error===failure);
  await noSpool(config);
});

test('detects spool body tampering at the stored offset and closes its file after decompression failure',async()=>{
  const config=await fixture([message('r1',null,'prompter','request'),message('a1','r1','assistant','reply')]);
  await assert.rejects(prepareOasst({...config,onProgress:async progress=>{if(progress.stage==='spool.complete'){const handle=await open(progress.path,'r+');try{await handle.write(Buffer.from('['),0,1,0);}finally{await handle.close();}}}}),/spool hash changed/);
  await noSpool(config);
  const broken=await fixture([]),bytes=Buffer.from('not gzip');await writeFile(broken.archive,bytes);
  const capturePath=path.join(broken.root,'capture.json'),capture=JSON.parse(await readFile(capturePath,'utf8'));await writeFile(capturePath,JSON.stringify({...capture,sha256:sha256Bytes(bytes),bytes:bytes.length}));
  await assert.rejects(prepareOasst(broken));await noSpool(broken);
});

test('packed complete multi-turn paths retain all ancestor edges and independent-root boundaries',async()=>{
  const rows=[];
  for(let n=0;n<8;n++){
    const id=`path${n}`,extra={message_tree_id:id};
    rows.push(message(id,null,'prompter',`e\u0301 ${n}`,extra),message(`${id}-a`,id,'assistant','👩‍👩‍👧‍👦 first',extra),
      message(`${id}-p`,`${id}-a`,'prompter','雪 followup',extra),message(`${id}-b`,`${id}-p`,'assistant','complete continuation',extra));
  }
  const config=await fixture(rows),plain=await prepareOasst({...config,mode:'paths',limits:{ca:8}}),original=await documents(plain,config.out);
  assert.ok(original.some(doc=>doc.turns.length===4),'Fixture must exercise a full ancestor path');
  const maxTextBytes=Math.max(...original.map(doc=>Buffer.byteLength(doc.text)));
  for(const [name,textBound]of [['large',65536],['small',maxTextBytes]]){
    const packedConfig={...config,out:path.join(config.root,name),mode:'paths',limits:{ca:8},packing:{maxSerializedBytes:65536,maxTextBytes:textBound}};
    const report=await prepareOasst(packedConfig),packed=await documents(report,packedConfig.out);
    assert.deepEqual(ordered(packed.flatMap(unpack)),ordered(original));
    for(const doc of packed){validateDeclaredTranscriptSource(doc);for(const conversation of doc.sourceMetadata.conversations){
      const [start,end]=conversation.turnRange;assert.equal(doc.turns[start].replyToTurnIndex,undefined);
      for(let index=start+1;index<end;index++){assert.equal(doc.turns[index].replyToTurnIndex,index-1);assert.equal(doc.sourceMetadata.lineage[index].parentId,doc.sourceMetadata.lineage[index-1].id);}
    }}
  }
});

test('CLI declares both packing bounds and the spool/index budgets without touching an existing output',async()=>{
  const config=await fixture([message('r1',null,'prompter','request'),message('a1','r1','assistant','reply')]);
  const cli=fileURLToPath(new URL('../prepare-oasst.mjs',import.meta.url));
  const args=[cli,'--archive',config.archive,'--out',config.out,'--limits','ca=3','--max-spool-bytes','8192','--max-index-bytes','1048576','--pack-max-serialized-bytes','32768','--pack-max-text-bytes','4096'];
  execFileSync(process.execPath,args,{stdio:'pipe',timeout:30000,maxBuffer:65536});
  const report=JSON.parse(await readFile(path.join(config.out,'preparation.json'),'utf8'));
  assert.deepEqual(report.limits.packing,{maxSerializedBytes:32768,maxTextBytes:4096});assert.equal(report.limits.maxSpoolBytes,8192);assert.equal(report.limits.maxSerializedIndexBytes,1048576);
  const before=await readFile(path.join(config.out,'preparation.json'));
  assert.throws(()=>execFileSync(process.execPath,args,{stdio:'pipe',timeout:30000,maxBuffer:65536}));
  assert.deepEqual(await readFile(path.join(config.out,'preparation.json')),before);
  for(const extra of [['--pack-max-serialized-bytes','32768'],['--max-spool-btyes','8192']]){
    const bad=[cli,'--archive',config.archive,'--out',path.join(config.root,'invalid'),'--limits','ca=3',...extra];
    assert.throws(()=>execFileSync(process.execPath,bad,{stdio:'pipe',timeout:30000,maxBuffer:65536}));
  }
});

test('retains the existing valid serialized transcript when a capture has no optional URL',async()=>{
  const config=await fixture([message('r1',null,'prompter','request'),message('a1','r1','assistant','reply')]);
  const capturePath=path.join(config.root,'capture.json'),capture=JSON.parse(await readFile(capturePath,'utf8'));delete capture.url;await writeFile(capturePath,JSON.stringify(capture));
  const plain=await prepareOasst(config),packedConfig={...config,out:path.join(config.root,'packed'),packing:{maxSerializedBytes:32768,maxTextBytes:4096}},packed=await prepareOasst(packedConfig);
  const original=await documents(plain,config.out),restored=(await documents(packed,packedConfig.out)).flatMap(unpack);
  assert.deepEqual(restored,original);for(const doc of original){assert.equal(Object.hasOwn(doc.sourceMetadata,'url'),false);validateDeclaredTranscriptSource(doc);}
});

test('keeps declared selection and packing budgets immutable across awaited progress observers',async()=>{
  const config=await fixture([message('r1',null,'prompter','request'),message('a1','r1','assistant','reply'),
    message('r2',null,'prompter','second',{message_tree_id:'r2'}),message('a2','r2','assistant','second reply',{message_tree_id:'r2'})]);
  const limits={ca:1},packing={maxSerializedBytes:32768,maxTextBytes:4096};
  const report=await prepareOasst({...config,limits,packing,onProgress:()=>{limits.ca=2;packing.maxTextBytes=1;packing.maxSerializedBytes=65536;}});
  assert.deepEqual(report.limits.perLocale,{ca:1});assert.deepEqual(report.limits.packing,{maxSerializedBytes:32768,maxTextBytes:4096});assert.equal(report.locales.ca.retainedDocuments,1);
});
