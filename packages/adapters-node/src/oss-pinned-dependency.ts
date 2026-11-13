// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { canonicalJsonByteLength, canonicalStringify, createHasher } from "@scce/kernel";
import { inspectEngineeringCorpusFolder, type EngineeringCorpusFileInspection } from "./engineering-corpus-folder.js";

export interface OssPinnedDependencyDeclaration {
  readonly lockfilePath: string;
  readonly packageLocation: string;
  readonly archivePath: string;
  readonly directoryPath: string;
  readonly expected?: { readonly lockfileContentHash: string; readonly packageName: string; readonly version: string; readonly archiveUri: string; readonly integrity: string; readonly snapshotHash?: string };
}
export interface OssPinnedPackageSnapshot {
  readonly schema: "scce.oss_pinned_package_snapshot.v1";
  readonly packageName: string; readonly version: string; readonly archiveUri: string; readonly integrity: string;
  readonly archiveContentHash: string; readonly snapshotHash: string;
  readonly files: readonly { readonly path: string; readonly contentHash: string; readonly byteLength: number }[];
}
export interface OssCorpusInventoryFile extends EngineeringCorpusFileInspection {
  readonly sourceUri?: string;
  readonly sourceDependencyPaths?: readonly string[];
  readonly sourceSnapshotHash?: string;
  readonly dependency?: { readonly snapshot: OssPinnedPackageSnapshot; readonly packageRelativePath: string; readonly directoryPath: string };
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sha256 = (bytes: Uint8Array) => `sha256_${createHash("sha256").update(bytes).digest("hex")}`;

export async function readOssPinnedDependencyManifest(input: { path: string; contentHash: string; sourceSnapshotHash: string; maxTotalBytes: number }) {
  const file = path.resolve(input.path), stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > input.maxTotalBytes) throw new Error("Pinned dependency manifest exceeds its source boundary");
  const bytes = await readFile(file), contentHash = sha256(bytes);
  if (!/^(?:sha256[_:])?[a-f0-9]{64}$/u.test(input.contentHash) || contentHash !== `sha256_${input.contentHash.replace(/^sha256[_:]/u, "")}`) throw new Error("Pinned dependency manifest SHA256 mismatch");
  const manifest = object(JSON.parse(bytes.toString("utf8")));
  if (manifest.schema !== "scce.oss_dependency_manifest.v1" || manifest.sourceSnapshotHash !== input.sourceSnapshotHash || !Array.isArray(manifest.packages)) throw new Error("Pinned dependency manifest differs from the inspected source snapshot");
  const declarations: OssPinnedDependencyDeclaration[] = [];
  for (const item of manifest.packages) {
    const row = object(item);
    for (const field of ["lockfilePath", "lockfileContentHash", "packageLocation", "packageName", "version", "archiveUri", "integrity", "archivePath", "directoryPath"]) {
      if (typeof row[field] !== "string" || !row[field]) throw new Error(`Pinned dependency manifest needs ${field}`);
    }
    declarations.push({ lockfilePath: checkedPath(String(row.lockfilePath)), packageLocation: checkedPath(String(row.packageLocation)),
      archivePath: path.resolve(path.dirname(file), checkedPath(String(row.archivePath))), directoryPath: path.resolve(path.dirname(file), checkedPath(String(row.directoryPath))),
      expected: { lockfileContentHash: String(row.lockfileContentHash), packageName: String(row.packageName), version: String(row.version), archiveUri: String(row.archiveUri), integrity: String(row.integrity),
        ...(typeof row.snapshotHash === "string" ? { snapshotHash: row.snapshotHash } : {}) } });
  }
  return { contentHash, declarations, sourceSnapshotHash: input.sourceSnapshotHash };
}
function checkedPath(value: string): string {
  if (!value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)
    || value !== path.posix.normalize(value) || value.split("/").some(part => !part || part === "." || part === ".." || part.includes(":"))) throw new Error("Unsafe pinned package path");
  return value;
}
function tarNumber(field: Buffer): number {
  const text = field.toString("ascii").replace(/\0/g, "").trim();
  if (text && !/^[0-7]+$/u.test(text)) throw new Error("Unsupported pinned package tar number");
  const value = text ? Number.parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid pinned package tar number");
  return value;
}

/** Registry integrity is checked before any archive member can become a source descriptor. */
export function inspectPinnedPackageArchive(input: { bytes: Uint8Array; packageName: string; version: string; archiveUri: string; integrity: string; maxFileBytes: number; maxTotalBytes: number }): OssPinnedPackageSnapshot {
  if (input.bytes.byteLength > input.maxTotalBytes || input.integrity !== `sha512-${createHash("sha512").update(input.bytes).digest("base64")}`) throw new Error("Pinned package archive integrity differs from lockfile");
  const tar = gunzipSync(input.bytes, { maxOutputLength: input.maxTotalBytes });
  const files: Array<{ path: string; contentHash: string; byteLength: number }> = [], names = new Set<string>();
  let offset = 0, root: string | undefined, sourceBytes = 0, packageJson: Record<string, unknown> | undefined, ended = false;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) { ended = tar.subarray(offset).every(byte => byte === 0); break; }
    const checksum = tarNumber(header.subarray(148, 156));
    const measured = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== measured) throw new Error("Pinned package tar checksum mismatch");
    const field = (start: number, end: number) => header.subarray(start, end).toString("utf8").split("\0", 1)[0]!;
    const prefix = field(345, 500), name = checkedPath(`${prefix ? `${prefix}/` : ""}${field(0, 100)}`.replace(/\/$/u, ""));
    const parts = name.split("/"); root ??= parts[0];
    if (parts[0] !== root) throw new Error("Pinned package archive has multiple source roots");
    const kind = header[156], size = tarNumber(header.subarray(124, 136));
    if (kind !== 0 && kind !== 48 && kind !== 53) throw new Error("Pinned package archive links and special entries are forbidden");
    const end = offset + 512 + size;
    if (end > tar.byteLength || size > input.maxFileBytes) throw new Error("Pinned package archive exceeds source bounds");
    if (kind === 53 && size !== 0) throw new Error("Pinned package directory carries unexpected bytes");
    if (kind !== 53) {
      const relative = checkedPath(parts.slice(1).join("/"));
      if (names.has(relative)) throw new Error("Pinned package archive repeats a source path");
      names.add(relative); sourceBytes += size;
      const bytes = tar.subarray(offset + 512, end);
      files.push({ path: relative, contentHash: sha256(bytes), byteLength: size });
      if (relative === "package.json") packageJson = object(JSON.parse(bytes.toString("utf8")));
      if (sourceBytes + canonicalJsonByteLength(files, input.maxTotalBytes) > input.maxTotalBytes) throw new Error("Pinned package source and descriptor budget exceeded");
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!ended || packageJson?.name !== input.packageName || packageJson.version !== input.version) throw new Error("Pinned package archive does not declare the locked package identity");
  files.sort((a, b) => a.path.localeCompare(b.path));
  const material = { schema: "scce.oss_pinned_package_snapshot.v1" as const, packageName: input.packageName, version: input.version,
    archiveUri: input.archiveUri, integrity: input.integrity, archiveContentHash: sha256(input.bytes), files };
  return { ...material, snapshotHash: createHasher().digestHex(canonicalStringify(material)) };
}

export async function prepareOssPinnedDependencies(input: { rootPath: string; inventory: readonly EngineeringCorpusFileInspection[]; declarations: readonly OssPinnedDependencyDeclaration[]; maxFileBytes: number; maxTotalBytes: number }): Promise<{ files: OssCorpusInventoryFile[]; snapshots: OssPinnedPackageSnapshot[] }> {
  const inventory = new Map(input.inventory.map(file => [file.path, file])), files: OssCorpusInventoryFile[] = [], snapshots: OssPinnedPackageSnapshot[] = [];
  let descriptorBytes = 0;
  for (const declaration of input.declarations) {
    const lockPath = checkedPath(declaration.lockfilePath), location = checkedPath(declaration.packageLocation), lock = inventory.get(lockPath);
    if (!lock?.contentHash) throw new Error("Pinned dependency lockfile is outside the inspected source inventory");
    const lockBytes = await readFile(lock.absolutePath);
    if (lockBytes.byteLength !== lock.byteLength || sha256(lockBytes) !== lock.contentHash.replace(/^sha256:/u, "sha256_")) throw new Error("Pinned dependency lockfile changed after snapshot inspection");
    if (declaration.expected && declaration.expected.lockfileContentHash !== lock.contentHash.replace(/^sha256:/u, "sha256_")) throw new Error("Pinned dependency manifest lockfile identity mismatch");
    const entry = object(object(JSON.parse(lockBytes.toString("utf8"))).packages)[location];
    const pin = object(entry), archiveUri = String(pin.resolved ?? ""), url = new URL(archiveUri);
    if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.username || url.password || url.hash || url.search || url.port || !pin.version || !pin.integrity) throw new Error("Pinned dependency needs an exact official registry lock entry");
    if (!location.startsWith("node_modules/") && !location.includes("/node_modules/")) throw new Error("Pinned dependency lock location is not a package root");
    const packageName = location.split("node_modules/").at(-1)!;
    if (!packageName || packageName.split("/").length !== (packageName.startsWith("@") ? 2 : 1)) throw new Error("Pinned dependency lock location is not a package root");
    if (declaration.expected && (declaration.expected.packageName !== packageName || declaration.expected.version !== pin.version
      || declaration.expected.archiveUri !== archiveUri || declaration.expected.integrity !== pin.integrity)) throw new Error("Pinned dependency manifest package identity mismatch");
    const archiveStat = await lstat(declaration.archivePath).catch(() => { throw new Error(`Pinned package cache is missing ${packageName}@${String(pin.version)}: prepare ${archiveUri} with ${String(pin.integrity)}`); });
    if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.size > input.maxTotalBytes) throw new Error("Pinned dependency archive exceeds the declared source boundary");
    const snapshot = inspectPinnedPackageArchive({ bytes: await readFile(declaration.archivePath), packageName, version: String(pin.version), archiveUri, integrity: String(pin.integrity), maxFileBytes: input.maxFileBytes, maxTotalBytes: input.maxTotalBytes });
    if (declaration.expected?.snapshotHash && declaration.expected.snapshotHash !== snapshot.snapshotHash) throw new Error("Pinned dependency snapshot manifest mismatch");
    descriptorBytes += canonicalJsonByteLength(snapshot, input.maxTotalBytes - descriptorBytes);
    if (descriptorBytes > input.maxTotalBytes) throw new Error("Pinned dependency descriptor budget exceeded");
    const directory = await realpath(declaration.directoryPath), directoryStat = await lstat(declaration.directoryPath);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Pinned dependency directory is not an owned extraction root");
    for (const member of snapshot.files) {
      const absolute = path.resolve(directory, member.path), stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await realpath(absolute) !== absolute) throw new Error("Pinned dependency member escapes its extraction root");
      const bytes = await readFile(absolute);
      if (bytes.byteLength !== member.byteLength || sha256(bytes) !== member.contentHash) throw new Error("Pinned dependency extracted bytes differ from the verified archive");
    }
    const inspected = await inspectEngineeringCorpusFolder(directory, { maxFiles: Math.max(1, snapshot.files.length), maxFileBytes: input.maxFileBytes, maxDepth: Math.max(...snapshot.files.map(file => file.path.split("/").length)), includeUnsupported: false });
    const mount = path.posix.join(path.posix.dirname(lockPath), location);
    for (const file of inspected.files.filter(file => file.importable)) {
      const member = snapshot.files.find(member => member.path === file.path);
      if (!member || file.contentHash !== member.contentHash) throw new Error("Pinned dependency inspection differs from verified archive inventory");
      const mounted = `${mount}/${file.path}`;
      if (inventory.has(mounted) || files.some(file => file.path === mounted)) throw new Error("Pinned dependency mount collides with another source");
      const sourceUri = `${archiveUri}#path=${encodeURIComponent(file.path)}`;
      descriptorBytes += canonicalJsonByteLength({ path: mounted, absolutePath: file.absolutePath, contentHash: file.contentHash, byteLength: file.byteLength, sourceUri, sourceDependencyPaths: [lockPath], sourceSnapshotHash: snapshot.snapshotHash }, input.maxTotalBytes - descriptorBytes);
      if (descriptorBytes > input.maxTotalBytes) throw new Error("Pinned dependency descriptor budget exceeded");
      files.push({ ...file, path: mounted, sourceUri, sourceDependencyPaths: [lockPath], sourceSnapshotHash: snapshot.snapshotHash,
        dependency: { snapshot, packageRelativePath: file.path, directoryPath: directory } });
    }
    snapshots.push(snapshot);
  }
  return { files, snapshots };
}
