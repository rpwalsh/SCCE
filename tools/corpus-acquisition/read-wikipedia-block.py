"""Read a real indexed multistream block without downloading the complete XML.

Original compressed bytes and page XML are retained alongside derived wikitext.
This is source acquisition; it never claims unread pages are ingested or trained.
"""
import argparse,bz2,hashlib,json,pathlib,urllib.request,xml.etree.ElementTree as ET
BASE=pathlib.Path(__file__).resolve().parent
ROOT=BASE/'corpus-build'/'full-wikipedia'
parser=argparse.ArgumentParser();parser.add_argument('edition');parser.add_argument('title');args=parser.parse_args()
manifest=json.loads((ROOT/'manifest.json').read_text(encoding="utf-8"));edition=manifest['editions'][args.edition]
index=ROOT/manifest['indexesDownloaded'][args.edition]['path']
target=None;next_offset=None;matched=None
with bz2.open(index,'rt',encoding='utf-8') as stream:
    for line in stream:
        start,page_id,title=line.rstrip('\n').split(':',2);start=int(start)
        if target is not None and start>target:
            next_offset=start;break
        if title==args.title:
            target=start;matched={'pageId':int(page_id),'title':title}
if target is None:raise SystemExit('Title absent from the pinned index: '+args.title)
end=(next_offset or edition['xml']['bytes'])-1
length=end-target+1
if length>128*1024*1024:raise SystemExit('Compressed block exceeds the explicit 128MiB acquisition safety bound')
headers={'User-Agent':'SCCE-source-corpus-evaluation/1.0 (https://github.com/rpwalsh/scce)','Range':f'bytes={target}-{end}','Accept-Encoding':'identity'}
request=urllib.request.Request(edition['xml']['url'],headers=headers)
with urllib.request.urlopen(request,timeout=90) as response:
    if response.status!=206:raise RuntimeError('Provider did not honor byte Range; full-file response rejected before reading')
    expected=f'bytes {target}-{end}/'
    if not response.headers.get('Content-Range','').startswith(expected):raise RuntimeError('Provider Content-Range differs from the requested compressed block')
    compressed=response.read(length+1)
if len(compressed)!=length:raise RuntimeError('Compressed block byte length mismatch')
decoder=bz2.BZ2Decompressor();raw=decoder.decompress(compressed,max_length=256*1024*1024)
if not decoder.eof:raise RuntimeError('Decompressed block exceeds the explicit 256MiB safety bound or contains incomplete bzip2 data')
folder=ROOT/args.edition/'blocks'/edition['date']/str(target);folder.mkdir(parents=True,exist_ok=True)
(folder/'original.xml.bz2').write_bytes(compressed);(folder/'original.xml-fragment').write_bytes(raw)
records=[];position=0
while True:
    first=raw.find(b'<page>',position)
    if first<0:break
    last=raw.find(b'</page>',first)
    if last<0:raise RuntimeError('Page boundary incomplete in a complete indexed compressed stream')
    last+=len(b'</page>');page=raw[first:last];position=last
    element=ET.fromstring(page)
    # Some dumps declare the XML namespace on each page, others inherit it from the enclosing document.
    ns=element.tag.partition('}')[0]+'}' if element.tag.startswith('{') else ''
    title=element.findtext(ns+'title');page_id=element.findtext(ns+'id');revision=element.find(ns+'revision')
    text=revision.find(ns+'text') if revision is not None else None
    revision_id=revision.findtext(ns+'id') if revision is not None else None
    if text is None:continue
    slug=str(page_id);page_folder=folder/slug;page_folder.mkdir(exist_ok=True)
    (page_folder/'original-page.xml').write_bytes(page)
    wikitext=text.text or '';(page_folder/'article.wikitext').write_text(wikitext, encoding="utf-8")
    record={'edition':args.edition,'title':title,'pageId':page_id,'revisionId':revision_id,'namespace':element.findtext(ns+'ns'),'sourceUrl':edition['xml']['url'],'indexSha256':manifest['indexesDownloaded'][args.edition]['sha256'],'compressedRange':{'start':target,'endInclusive':end},'decompressedPageRange':{'start':first,'endExclusive':last},'pageXmlSha256':hashlib.sha256(page).hexdigest(),'wikitextSha256':hashlib.sha256(wikitext.encode()).hexdigest(),'relativePath':slug,'trained':False}
    (page_folder/'source-manifest.json').write_text(json.dumps(record,ensure_ascii=False,indent=2), encoding="utf-8");records.append(record)
block={'edition':args.edition,'requested':matched,'sourceUrl':edition['xml']['url'],'compressedStart':target,'compressedEndInclusive':end,'compressedBytes':length,'compressedSha256':hashlib.sha256(compressed).hexdigest(),'decompressedBytes':len(raw),'decompressedSha256':hashlib.sha256(raw).hexdigest(),'pageCount':len(records),'pages':records,'fullCorpusIngested':False}
(folder/'manifest.json').write_text(json.dumps(block,ensure_ascii=False,indent=2), encoding="utf-8")
print(json.dumps({k:v for k,v in block.items() if k!='pages'},ensure_ascii=False))
