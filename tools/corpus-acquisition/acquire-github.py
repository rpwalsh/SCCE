"""Pin the top 20 nonfork, unarchived GitHub repositories per code language.

Acquire a bounded, source-exact first-build selection without running repository code.
The manifest explicitly records every selected and skipped file and byte limit.
"""
import concurrent.futures,hashlib,json,os,pathlib,shutil,subprocess,time,urllib.parse,urllib.request
BASE=pathlib.Path(__file__).resolve().parent
ROOT=BASE/'corpus-build'/'github';ROOT.mkdir(parents=True,exist_ok=True)
LANGS={'JavaScript':['.js','.jsx','.mjs','.cjs'],'TypeScript':['.ts','.tsx'],'Python':['.py'],'Java':['.java'],'C':['.c','.h'],'C++':['.cc','.cpp','.cxx','.hpp','.h'],'C#':['.cs'],'Go':['.go'],'Rust':['.rs'],'PHP':['.php'],'Ruby':['.rb'],'Swift':['.swift'],'Kotlin':['.kt','.kts'],'Scala':['.scala'],'Dart':['.dart'],'Haskell':['.hs'],'Elixir':['.ex','.exs'],'Lua':['.lua'],'R':['.r','.R'],'Julia':['.jl']}
manifest={'selection':'GitHub Search API, stars descending, fork:false archived:false; 20 repositories per language','programmingLanguages':list(LANGS),'bounds':{'codeFilesPerRepo':32,'documentationFilesPerRepo':16,'maxFileBytes':131072,'maxSelectedBytesPerRepo':2097152},'catalog':{},'acquired':{},'failures':[]}
manifest_path=ROOT/'manifest.json'
if manifest_path.exists():manifest=json.loads(manifest_path.read_text())
def checkpoint():manifest_path.write_text(json.dumps(manifest,indent=2))
def request_json(url):
    with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'SCCE-source-corpus-evaluation/1.0'}),timeout=40) as response:return json.load(response)
def git(args,cwd=None):
    p=subprocess.run(['git','-c','core.hooksPath=/dev/null','-c','submodule.recurse=false',*args],cwd=cwd,text=True,capture_output=True,timeout=180)
    if p.returncode:raise RuntimeError(p.stderr[-1500:])
    return p.stdout
def acquire(language,row):
    name=row['full_name'];slug=name.replace('/','__');folder=ROOT/'repositories'/slug
    if (folder/'source-manifest.json').exists():return name,json.loads((folder/'source-manifest.json').read_text())
    folder.mkdir(parents=True,exist_ok=True)
    checkout=ROOT/'checkouts'/slug;checkout.parent.mkdir(exist_ok=True)
    if not (checkout/'.git').exists():
        git(['clone','--depth=1','--filter=blob:none','--no-checkout','--single-branch','--branch',row['default_branch'],'https://github.com/'+name+'.git',str(checkout)])
    commit=git(['rev-parse','HEAD'],cwd=checkout).strip()
    tree=git(['ls-tree','-r','--full-tree',commit],cwd=checkout)
    entries=[]
    for line in tree.splitlines():
        metadata,path=line.split('\t',1);mode,kind,oid=metadata.split(' ',2)
        if kind!='blob' or mode!='100644' or any(x in path for x in ['*','?','[',']','\n','\\']):continue
        parts=pathlib.PurePosixPath(path).parts
        if any(p in ['node_modules','vendor','third_party','dist','build','.git'] for p in parts):continue
        entries.append((path,oid))
    code=[e for e in entries if pathlib.PurePosixPath(e[0]).suffix in LANGS[language] and not e[0].endswith('.min.js')]
    docs=[e for e in entries if pathlib.PurePosixPath(e[0]).suffix.lower() in ['.md','.rst','.txt','.adoc'] or pathlib.PurePosixPath(e[0]).name.lower().startswith(('license','copying'))]
    key=lambda e:hashlib.sha256((commit+':'+e[0]).encode()).digest()
    code=sorted(code,key=key)[:32]
    docs=sorted(docs,key=lambda e:(0 if pathlib.PurePosixPath(e[0]).name.lower().startswith(('readme','license','copying')) else 1,key(e)))[:16]
    selected=sorted(set(code+docs));patterns='\n'.join('/'+p for p,o in selected)+'\n'
    git(['sparse-checkout','init','--no-cone'],cwd=checkout)
    p=subprocess.run(['git','-c','core.hooksPath=/dev/null','sparse-checkout','set','--no-cone','--stdin'],cwd=checkout,input=patterns,text=True,capture_output=True,timeout=180)
    if p.returncode:raise RuntimeError(p.stderr[-1000:])
    git(['checkout','--force',commit],cwd=checkout)
    result={'repository':name,'language':language,'starsAtSelection':row['stargazers_count'],'defaultBranch':row['default_branch'],'commit':commit,'license':row.get('license'),'sourceUrl':'https://github.com/'+name,'selectedFiles':[],'skippedFiles':[],'selectedBytes':0,'availableCodeFiles':sum(pathlib.PurePosixPath(e[0]).suffix in LANGS[language] for e in entries),'treeSha256':hashlib.sha256(tree.encode()).hexdigest()}
    for path,oid in selected:
        source=checkout/path
        if not source.is_file() or source.is_symlink():continue
        length=source.stat().st_size
        if length>131072 or result['selectedBytes']+length>2097152:
            result['skippedFiles'].append({'path':path,'bytes':length,'reason':'explicit_first_build_byte_bound'});continue
        data=source.read_bytes()
        try:data.decode('utf-8')
        except UnicodeDecodeError:
            result['skippedFiles'].append({'path':path,'bytes':length,'reason':'not_utf8'});continue
        dest=folder/'source'/path;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)
        result['selectedFiles'].append({'path':path,'gitBlob':oid,'bytes':length,'sha256':hashlib.sha256(data).hexdigest(),'url':f'https://github.com/{name}/blob/{commit}/{urllib.parse.quote(path)}'})
        result['selectedBytes']+=length
    (folder/'source-manifest.json').write_text(json.dumps(result,indent=2))
    # Source bytes, commit and tree identity remain; discard the reproducible transfer cache.
    shutil.rmtree(checkout)
    return name,result

for language in LANGS:
    if language not in manifest['catalog']:
        query=urllib.parse.urlencode({'q':f'language:{language} fork:false archived:false','sort':'stars','order':'desc','per_page':20})
        try:
            data=request_json('https://api.github.com/search/repositories?'+query)
            manifest['catalog'][language]=data['items'];checkpoint()
            print(json.dumps({'catalog':language,'repositories':len(data['items'])}),flush=True)
        except Exception as error:
            manifest['failures'].append({'stage':'catalog','language':language,'error':str(error)});checkpoint();continue
        time.sleep(6.5)
    rows=manifest['catalog'][language]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        pending={pool.submit(acquire,language,row):row['full_name'] for row in rows if row['full_name'] not in manifest['acquired']}
        for future in concurrent.futures.as_completed(pending):
            try:
                name,result=future.result();manifest['acquired'][name]=result
                print(json.dumps({'acquired':name,'language':language,'files':len(result['selectedFiles']),'bytes':result['selectedBytes']}),flush=True)
            except Exception as error:
                manifest['failures'].append({'stage':'source','repository':pending[future],'error':str(error)});print(json.dumps({'failed':pending[future],'error':str(error)}),flush=True)
            checkpoint()
manifest['status']='acquired_first_build_selections' if not manifest['failures'] else 'partial_acquisition'
checkpoint()
