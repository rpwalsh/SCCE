"""Download source-attributed bilingual records; never generate translations."""
import bz2, concurrent.futures, hashlib, heapq, json, pathlib, time, urllib.request

BASE=pathlib.Path(__file__).resolve().parent
ROOT=BASE/'corpus-build'/'tatoeba'
RAW=ROOT/'raw'
RAW.mkdir(parents=True,exist_ok=True)
LANGS={'eng':'English','spa':'Spanish (regional variety unverified)','fra':'French','deu':'German','por':'Portuguese','ita':'Italian','nld':'Dutch','rus':'Russian','ukr':'Ukrainian','ara':'Arabic','heb':'Hebrew','hin':'Hindi','guj':'Gujarati','ben':'Bengali','cmn':'Mandarin Chinese','kor':'Korean','jpn':'Japanese','hat':'Haitian Creole','swh':'Swahili','tlh':'Klingon'}
manifest={'source':'https://tatoeba.org/en/downloads','license':'CC-BY-2.0-FR; retain contributor attribution','languages':LANGS,'files':{},'coverage':{},'failures':[],'pairLimitPerLanguage':5000,'requestedSpanishLocale':'es-MX; these exports do not certify regional variety'}

def checkpoint():
    (ROOT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))

def download(name):
    lang=name.split('_')[0] if '_sentences_' in name else 'eng'
    url=f'https://downloads.tatoeba.org/exports/per_language/{lang}/{name}'
    dest=RAW/name
    if not dest.exists():
        req=urllib.request.Request(url,headers={'User-Agent':'SCCE-source-corpus-evaluation/1.0'})
        stage=dest.with_suffix(dest.suffix+'.part')
        with urllib.request.urlopen(req,timeout=60) as response, stage.open('wb') as out:
            while block:=response.read(1024*1024):out.write(block)
        stage.replace(dest)
    digest=hashlib.file_digest(dest.open('rb'),'sha256').hexdigest()
    return name,dict(url=url,bytes=dest.stat().st_size,sha256=digest)

names=[f'{code}_sentences_detailed.tsv.bz2' for code in LANGS]
names += [f'eng-{code}_links.tsv.bz2' for code in LANGS if code!='eng']
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    pending={pool.submit(download,name):name for name in names}
    for future in concurrent.futures.as_completed(pending):
        name=pending[future]
        try:
            key,row=future.result();manifest['files'][key]=row
            print(json.dumps({'downloaded':key,**row}),flush=True)
        except Exception as error:
            manifest['failures'].append({'file':name,'error':str(error)})
            print(json.dumps({'failed':name,'error':str(error)}),flush=True)
        checkpoint()

def links(path):
    with bz2.open(path,'rt',encoding='utf-8') as stream:
        for line in stream:
            a,b=line.rstrip('\n').split('\t')[:2]
            yield (int(a),int(b))

selected={}
english_ids=set()
for code in LANGS:
    path=RAW/f'eng-{code}_links.tsv.bz2'
    if code=='eng' or not path.exists():continue
    pairs=heapq.nsmallest(5000,links(path),key=lambda p:hashlib.sha256(f'{p[0]}:{p[1]}'.encode()).digest())
    selected[code]=pairs
    english_ids.update(a for a,b in pairs)

def read_selected(code,ids):
    result={};path=RAW/f'{code}_sentences_detailed.tsv.bz2'
    if not path.exists():return result
    with bz2.open(path,'rt',encoding='utf-8') as stream:
        for line in stream:
            fields=line.rstrip('\n').split('\t')
            if len(fields)<3:continue
            number=int(fields[0])
            if number in ids:
                result[number]={'id':number,'language':fields[1],'text':fields[2],'contributor':fields[3] if len(fields)>3 else None,'added':fields[4] if len(fields)>4 else None,'modified':fields[5] if len(fields)>5 else None,'url':f'https://tatoeba.org/en/sentences/show/{number}'}
    return result

english=read_selected('eng',english_ids)
outdir=ROOT/'pairs';outdir.mkdir(exist_ok=True)
for code,pairs in selected.items():
    target=read_selected(code,{b for a,b in pairs})
    records=[]
    for a,b in pairs:
        if a not in english or b not in target:continue
        # Split by English sentence identity; reciprocal directions stay together.
        bucket=int(hashlib.sha256(f'tatoeba:{a}'.encode()).hexdigest()[:8],16)%10
        split='test' if bucket==0 else 'calibration' if bucket==1 else 'train'
        records.append({'schema':'scce.evaluation.source_parallel_pair.v1','split':split,'source':english[a],'target':target[b],'alignment':'source-provided direct translation link; not independently certified','license':'CC-BY-2.0-FR','linkExport':manifest['files'].get(f'eng-{code}_links.tsv.bz2')})
    (outdir/f'eng-{code}.jsonl').write_text(''.join(json.dumps(row,ensure_ascii=False)+'\n' for row in records))
    manifest['coverage'][code]={'selectedLinks':len(pairs),'materializedPairs':len(records),'splits':{s:sum(r['split']==s for r in records) for s in ['train','calibration','test']}}
    checkpoint();print(json.dumps({'coverage':code,**manifest['coverage'][code]}),flush=True)
manifest['status']='acquired' if not manifest['failures'] else 'partial_acquisition'
checkpoint()
