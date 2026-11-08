"""Copy pinned, checksum-verified Wikipedia source parts to an unpublished release."""
import argparse,base64,hashlib,json,math,os,pathlib,re,subprocess,tempfile,urllib.parse,urllib.request
parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['validate','prepare','mirror','finalize']);parser.add_argument('--edition');args=parser.parse_args()
plan=json.loads(pathlib.Path('dump-plan.json').read_text());repo=os.environ.get('GH_REPO','rpwalsh/SCCE');tag=plan['releaseTag']
HEADERS={'User-Agent':'SCCE-source-corpus-build/1.0 (https://github.com/rpwalsh/SCCE)'}
def gh(*args):return subprocess.check_output(['gh',*args],text=True)
def view(required=True):
    page=1
    while True:
        rows=json.loads(gh('api',f'repos/{repo}/releases?per_page=100&page={page}'))
        found=next((row for row in rows if row['tag_name']==tag),None)
        if found:return {'isDraft':found['draft'],'url':found['html_url'],'apiUrl':found['url']}
        if len(rows)<100:break
        page+=1
    if required:raise RuntimeError('Pinned draft release not found')
    return None
def upload(path):
    # Source names are immutable: never overwrite a conflicting existing asset.
    release=view()
    if not release['isDraft']:raise RuntimeError('Refusing to alter a published release')
    digest=hashlib.file_digest(path.open('rb'),'sha256').hexdigest()
    all_assets={}
    page=1
    while True:
        rows=json.loads(gh('api',release['apiUrl']+f'/assets?per_page=100&page={page}'))
        all_assets.update((r['name'],r) for r in rows)
        if len(rows)<100:break
        page+=1
    existing=all_assets.get(path.name)
    if existing:
        if existing.get('digest')=='sha256:'+digest and existing['size']==path.stat().st_size:return
        raise RuntimeError('Existing release asset conflicts with pinned bytes: '+path.name)
    subprocess.run(['gh','release','upload',tag,str(path),'--repo',repo],check=True)
def write_status(status):
    branch=os.environ['GITHUB_REF_NAME'];path='tools/corpus-acquisition/latest-source-status.json'
    info={'status':status,'runUrl':f'https://github.com/{repo}/actions/runs/'+os.environ['GITHUB_RUN_ID'],'releaseUrl':view()['url'],'sourcePlan':plan['schema'],'editions':len(plan['editions']),'trainedBrain':False}
    body={'message':'Record full Wikipedia source acquisition status','branch':branch,'content':base64.b64encode((json.dumps(info,indent=2)+'\n').encode()).decode()}
    try:body['sha']=json.loads(gh('api',f'repos/{repo}/contents/{path}?ref={branch}'))['sha']
    except subprocess.CalledProcessError:pass
    payload=pathlib.Path('status-request.json');payload.write_text(json.dumps(body))
    subprocess.run(['gh','api','--method','PUT',f'repos/{repo}/contents/{path}','--input',str(payload)],check=True,stdout=subprocess.DEVNULL)
if args.mode=='validate':
    count=0;total=0
    for code,edition in plan['editions'].items():
        if not re.fullmatch(r'[a-z]{2,3}wiki',code):raise ValueError('Unexpected edition identifier')
        for item in edition['files']:
            u=urllib.parse.urlsplit(item['url'])
            if u.scheme!='https' or u.hostname!='dumps.wikimedia.org' or item['name']!=pathlib.PurePosixPath(u.path).name:raise ValueError('Unexpected source URL or filename')
            if not re.fullmatch(r'[0-9a-f]{40}',item['sha1']) or item['bytes']<1:raise ValueError('Missing pinned provider checksum or byte length')
            count+=math.ceil(item['bytes']/plan['chunkBytes']);total+=item['bytes']
    if plan['chunkBytes']>=2*1024**3 or count+len(plan['editions'])+4>=1000:raise ValueError('GitHub release asset limits exceeded')
    if total!=plan['transferBytes']:raise ValueError('Source transfer total mismatch')
    print(json.dumps({'valid':True,'editions':len(plan['editions']),'sourceAssets':count,'sourceBytes':total,'published':False,'trained':False}))
elif args.mode=='prepare':
    release=view(required=False)
    if release is None:
        pathlib.Path('source-notice.txt').write_text('Pinned Wikipedia source dumps, not a trained SCCE brain. Keep this release unpublished. Wikipedia text is CC BY-SA 4.0; original source URLs and provider checksums are in dump-plan.json. Klingon has no current Wikimedia edition.\n')
        subprocess.run(['gh','release','create',tag,'--repo',repo,'--draft','--target',os.environ['GITHUB_SHA'],'--title','SCCE full Wikipedia source corpus — 2026-11-08 catalog','--notes-file','source-notice.txt'],check=True)
        release=view()
    if not release['isDraft']:raise RuntimeError('Existing source release is published; refusing to reuse it')
    upload(pathlib.Path('dump-plan.json'));write_status('running')
    with open(os.environ['GITHUB_OUTPUT'],'a') as f:f.write('editions='+json.dumps(list(plan['editions']))+'\n')
elif args.mode=='mirror':
    edition=plan['editions'][args.edition];records=[]
    with tempfile.TemporaryDirectory(prefix='scce-wiki-') as scratch:
        for item in edition['files']:
            sha1=hashlib.sha1();sha256=hashlib.sha256();length=0;chunks=[]
            for start in range(0,item['bytes'],plan['chunkBytes']):
                end=min(start+plan['chunkBytes'],item['bytes'])-1
                name=item['name'] if item['bytes']<=plan['chunkBytes'] else item['name']+f'.chunk{len(chunks)+1:04d}'
                path=pathlib.Path(scratch)/name;chunk_hash=hashlib.sha256();chunk_length=0
                headers={**HEADERS,'Range':f'bytes={start}-{end}','Accept-Encoding':'identity'}
                with urllib.request.urlopen(urllib.request.Request(item['url'],headers=headers),timeout=120) as response,path.open('wb') as out:
                    whole=start==0 and end==item['bytes']-1
                    if response.status!=206 and not (whole and response.status==200):raise RuntimeError('Provider ignored a partial byte Range; full response rejected')
                    if response.status==206 and response.headers.get('Content-Range')!=f'bytes {start}-{end}/{item["bytes"]}':raise RuntimeError('Content-Range differs from pinned source coordinates')
                    while block:=response.read(1024*1024):
                        out.write(block);length+=len(block);chunk_length+=len(block);sha1.update(block);sha256.update(block);chunk_hash.update(block)
                        if chunk_length>end-start+1:raise RuntimeError('Byte Range response exceeded its declared length')
                if chunk_length!=end-start+1:raise RuntimeError('Byte Range response was incomplete')
                upload(path);chunks.append({'asset':name,'offset':start,'bytes':chunk_length,'sha256':chunk_hash.hexdigest()});path.unlink()
                print(json.dumps({'edition':args.edition,'mirrored':name,'bytes':chunk_length}),flush=True)
            if length!=item['bytes'] or sha1.hexdigest()!=item['sha1']:raise RuntimeError('Complete source checksum or byte length mismatch: '+item['name'])
            records.append({**item,'sha256':sha256.hexdigest(),'chunks':chunks,'verified':True})
    result=pathlib.Path(args.edition+'-mirror.json');result.write_text(json.dumps({'edition':args.edition,'date':edition['date'],'files':records,'complete':len(records)==len(edition['files']),'trained':False},indent=2));upload(result)
else:
    pathlib.Path('edition-results').mkdir(exist_ok=True)
    subprocess.run(['gh','release','download',tag,'--repo',repo,'--pattern','*-mirror.json','--dir','edition-results'],check=False)
    results={p.stem.removesuffix('-mirror'):json.loads(p.read_text()) for p in pathlib.Path('edition-results').glob('*-mirror.json')}
    complete=all(code in results and results[code]['complete'] for code in plan['editions'])
    write_status('source_acquisition_complete' if complete else 'source_acquisition_incomplete')
    if not complete:raise SystemExit('At least one source edition is incomplete; inspect failed jobs and rerun them')
