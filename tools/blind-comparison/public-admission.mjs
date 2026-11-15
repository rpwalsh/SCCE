import { stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileHash, jsonLines } from './protocol.mjs';

export const PUBLIC_ADMISSION_SCHEMA = 'scce.blind-public-admission.v1';
export async function admissionArtifacts(manifest, manifestFile) {
  if (manifest.schema !== PUBLIC_ADMISSION_SCHEMA) return [];
  if (manifest.complete !== true || manifest.purpose !== 'candidate_initial_public_prior'
    || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length || manifest.artifacts.length > 100000
    || !Array.isArray(manifest.sources) || manifest.sources.some(s => s.public !== true)) throw new Error('Incomplete public admission export');
  const root = await realpath(path.dirname(path.resolve(manifestFile))), seen = new Set(), files = [];
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact.path !== 'string' || artifact.path.includes('\\') || path.isAbsolute(artifact.path)
      || artifact.path.split('/').some(p => !p || p === '.' || p === '..' || p.includes(':'))
      || !/^[a-f0-9]{64}$/u.test(artifact.sha256) || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0
      || seen.has(artifact.path)) throw new Error('Invalid public admission artifact');
    seen.add(artifact.path);
    const file = await realpath(path.join(root, artifact.path)), relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !(await stat(file)).isFile()
      || (await stat(file)).size !== artifact.sizeBytes || await fileHash(file) !== artifact.sha256) throw new Error('Public admission artifact integrity differs');
    files.push(file);
  }
  if (typeof manifest.sourceIndex !== 'string' || !seen.has(manifest.sourceIndex)
    || typeof manifest.metadataIndex !== 'string' || !seen.has(manifest.metadataIndex)) throw new Error('Public admission source index is not pinned');
  const declared = new Map(manifest.sources.map(s => [s.id, s])), versions = new Set();
  if (declared.size !== manifest.sources.length) throw new Error('Duplicate public admission source');
  let count = 0;
  for await (const row of jsonLines(path.join(root, manifest.sourceIndex), 1024 * 1024)) {
    if (row.kind !== 'source' || !seen.has(row.path) || row.public !== true || !declared.has(row.sourceVersionId)
      || versions.has(row.sourceVersionId) || !/^sha256_[a-f0-9]{64}$/u.test(row.contentHash)) throw new Error('Public admission source index differs');
    versions.add(row.sourceVersionId);
    const source = declared.get(row.sourceVersionId);
    if (source.naturalLanguage !== row.naturalLanguage || source.formalLanguage !== row.formalLanguage) throw new Error('Public admission language declaration differs');
    const artifact = manifest.artifacts.find(a => a.path === row.path);
    if (artifact.sha256 !== row.contentHash?.slice(7) || artifact.sizeBytes !== row.byteLength) throw new Error('Public admission source bytes differ');
    count++;
  }
  if (count !== manifest.sourceCount || count !== declared.size) throw new Error('Public admission source count differs');
  return files;
}
