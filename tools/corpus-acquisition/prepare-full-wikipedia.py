"""Pin complete multistream editions and fetch matching compressed indexes.

Large XML files remain at their immutable provider URLs until a storage/ingestion
layout can hold the selected editions and the resulting database.
"""
import concurrent.futures,hashlib,json,pathlib,re,shutil,urllib.request
BASE=pathlib.Path(__file__).resolve().parent
ROOT=BASE/'corpus-build'/'full-wikipedia';ROOT.mkdir(parents=True,exist_ok=True)
HOST='https://dumps.wikimedia.org'
HEADERS={'User-Agent':'SCCE-source-corpus-evaluation/1.0 (https://github.com/rpwalsh/scce)'}
EDITIONS={'enwiki':'English','eswiki':'Spanish (Mexico uses this edition)','frwiki':'French','dewiki':'German','ptwiki':'Portuguese','itwiki':'Italian','nlwiki':'Dutch','ruwiki':'Russian','ukwiki':'Ukrainian','arwiki':'Arabic','hewiki':'Hebrew','hiwiki':'Hindi','guwiki':'Gujarati','bnwiki':'Bengali','zhwiki':'Chinese','kowiki':'Korean','jawiki':'Japanese','htwiki':'Haitian Creole','swwiki':'Swahili'}
manifest={'schema':'scce.full_wikipedia_source_plan.v1','editions':{},'unavailable':{'tlhwiki':{'language':'Klingon','reason':'Wikimedia edition deleted/locked August2005 and moved offsite; no current Wikimedia multistream edition','source':'https://meta.wikimedia.org/wiki/History_of_the_Klingon_Wikipedia'}},'failures':[],'xmlDownloadsStarted':False,'indexesDownloaded':{}}
if (ROOT/'manifest.json').exists():manifest=json.loads((ROOT/'manifest.json').read_text())
def checkpoint():(ROOT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
def get(url):
    with urllib.request.urlopen(urllib.request.Request(url,headers=HEADERS),timeout=45) as response:return response.read()
def edition(code):
    listing=get(HOST+'/'+code+'/').decode();dates=sorted(set(re.findall(r'href="(\d{8})/"',listing)),reverse=True)
    for date in dates:
        url=f'{HOST}/{code}/{date}/dumpstatus.json';raw=get(url);status=json.loads(raw)
        job=status['jobs'].get('articlesmultistreamdumprecombine') or status['jobs'].get('articlesmultistreamdump',{})
        if job.get('status')!='done':continue
        files=job.get('files',{});prefix=f'{code}-{date}-pages-articles-multistream'
        xml=files.get(prefix+'.xml.bz2');index=files.get(prefix+'-index.txt.bz2')
        if not xml or not index:continue
        sha_url=f'{HOST}/{code}/{date}/{code}-{date}-sha1sums.txt'
        try:
            sha_raw=get(sha_url);hashes={parts[1].lstrip('*'):parts[0] for line in sha_raw.decode().splitlines() if len(parts:=line.split())==2}
        except Exception:sha_raw=b'';hashes={}
        # A generated file is not yet a fully checksummed snapshot. Keep the
        # gate for both members of the XML/index pair, and try an older run.
        if not hashes.get(prefix+'.xml.bz2') or not hashes.get(prefix+'-index.txt.bz2'):
            continue
        folder=ROOT/code;folder.mkdir(exist_ok=True);(folder/'dumpstatus.json').write_bytes(raw)
        if sha_raw:(folder/'sha1sums.txt').write_bytes(sha_raw)
        def record(name,data):return {'name':name,'url':HOST+data['url'],'bytes':data['size'],'providerSha1':hashes.get(name)}
        return code,{'language':EDITIONS[code],'date':date,'status':'complete','statusUrl':url,'statusSha256':hashlib.sha256(raw).hexdigest(),'xml':record(prefix+'.xml.bz2',xml),'index':record(prefix+'-index.txt.bz2',index),'splitFiles':status['jobs'].get('articlesmultistreamdump',{}).get('files',{})}
    raise RuntimeError('No completed combined multistream XML + matching index found in published dates')

with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    pending={pool.submit(edition,code):code for code in EDITIONS if code not in manifest['editions']}
    for future in concurrent.futures.as_completed(pending):
        code=pending[future]
        try:
            code,row=future.result();manifest['editions'][code]=row;print(json.dumps({'edition':code,'date':row['date'],'xmlBytes':row['xml']['bytes'],'indexBytes':row['index']['bytes']}),flush=True)
        except Exception as error:manifest['failures'].append({'edition':code,'error':str(error)});print(json.dumps({'failed':code,'error':str(error)}),flush=True)
        checkpoint()
manifest['xmlBytes']=sum(v['xml']['bytes'] for v in manifest['editions'].values())
manifest['indexBytes']=sum(v['index']['bytes'] for v in manifest['editions'].values())
manifest['workspaceFreeBytesAtPlanning']=shutil.disk_usage(ROOT).free
manifest['allCompressedSourcesFitCurrentFreeSpace']=manifest['xmlBytes']+manifest['indexBytes']<=manifest['workspaceFreeBytesAtPlanning']
checkpoint();print(json.dumps({'totalXmlBytes':manifest['xmlBytes'],'totalIndexBytes':manifest['indexBytes'],'freeBytes':manifest['workspaceFreeBytesAtPlanning']}),flush=True)

def download_index(code,row):
    info=row['index'];dest=ROOT/code/info['name'];stage=dest.with_suffix(dest.suffix+'.part')
    if not dest.exists():
        with urllib.request.urlopen(urllib.request.Request(info['url'],headers=HEADERS),timeout=90) as response,stage.open('wb') as out:
            while block:=response.read(1024*1024):out.write(block)
        stage.replace(dest)
    sha1=hashlib.file_digest(dest.open('rb'),'sha1').hexdigest();sha256=hashlib.file_digest(dest.open('rb'),'sha256').hexdigest()
    if dest.stat().st_size!=info['bytes']:raise RuntimeError('Index byte length differs from published manifest')
    if info.get('providerSha1') and sha1!=info['providerSha1']:raise RuntimeError('Index SHA-1 differs from published checksum')
    return code,{'path':str(dest.relative_to(ROOT)),'bytes':dest.stat().st_size,'sha1':sha1,'sha256':sha256,'providerChecksumVerified':bool(info.get('providerSha1'))}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    pending={pool.submit(download_index,code,row):code for code,row in manifest['editions'].items() if code not in manifest['indexesDownloaded']}
    for future in concurrent.futures.as_completed(pending):
        code=pending[future]
        try:
            code,row=future.result();manifest['indexesDownloaded'][code]=row;print(json.dumps({'indexDownloaded':code,**row}),flush=True)
        except Exception as error:manifest['failures'].append({'index':code,'error':str(error)});print(json.dumps({'indexFailed':code,'error':str(error)}),flush=True)
        checkpoint()
manifest['status']='source_catalog_and_indexes_ready' if len(manifest['indexesDownloaded'])==len(EDITIONS) else 'partial_source_catalog_or_indexes'
checkpoint()
