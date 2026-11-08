"""Pin HTTP-range descriptors for the already acquired matching indexes."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import urllib.request

root = Path(__file__).resolve().parent / 'corpus-build' / 'full-wikipedia'
plan = json.loads((root / 'manifest.json').read_text(encoding="utf-8"))

def prepare(edition):
    item = plan['editions'][edition]
    index_record = plan['indexesDownloaded'][edition]
    index = root / index_record['path']
    sha256 = hashlib.sha256()
    sha1 = hashlib.sha1()
    with index.open('rb') as source:
        while block := source.read(1024 * 1024):
            sha256.update(block)
            sha1.update(block)
    if sha256.hexdigest() != index_record['sha256'] or sha1.hexdigest() != item['index']['providerSha1']:
        raise RuntimeError(f'{edition}: index differs from its pinned checksums')
    request = urllib.request.Request(item['xml']['url'], headers={
        'User-Agent': 'SCCE-streaming-ingestion/1.0 (https://github.com/rpwalsh/SCCE)',
        'Range': 'bytes=0-0', 'Accept-Encoding': 'identity',
    })
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 206 or response.headers.get('Content-Range') != f"bytes 0-0/{item['xml']['bytes']}":
            raise RuntimeError(f'{edition}: source did not honor its pinned byte range')
        etag = response.headers.get('ETag', '')
        if not etag.startswith('"') or not etag.endswith('"'):
            raise RuntimeError(f'{edition}: source has no strong ETag')
        if response.read(2) != b'B':
            raise RuntimeError(f'{edition}: source range has incorrect length or bzip2 signature')
    descriptor = {'schema': 'scce.wikipedia.remote_multistream.v1', 'url': item['xml']['url'],
                  'byteLength': item['xml']['bytes'], 'expectedSha1': item['xml']['providerSha1'],
                  'indexSha256': index_record['sha256'], 'etag': etag}
    path = root / edition / (item['xml']['name'] + '.remote.json')
    path.write_text(json.dumps(descriptor, indent=2) + '\n', encoding="utf-8")
    return edition, {'descriptor': str(path), 'index': str(index), 'source': descriptor,
                     'xmlDownloadedLocally': False, 'trainedComplete': False}

result = {'schema': 'scce.wikipedia.remote_source_catalog.v1', 'editions': {}, 'failures': {},
          'unavailable': plan.get('unavailable', {}), 'usesActions': False}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    futures = {pool.submit(prepare, edition): edition for edition in plan['editions']}
    for future in concurrent.futures.as_completed(futures):
        edition = futures[future]
        try:
            _, record = future.result()
            result['editions'][edition] = record
            print(json.dumps({'edition': edition, 'ready': True}), flush=True)
        except Exception as error:
            result['failures'][edition] = str(error)
            print(json.dumps({'edition': edition, 'error': str(error)}), flush=True)
(root / 'remote-sources.json').write_text(json.dumps(result, indent=2) + '\n', encoding="utf-8")
print(json.dumps({'ready': len(result['editions']), 'failures': result['failures']}), flush=True)
if result['failures']:
    raise SystemExit(1)
