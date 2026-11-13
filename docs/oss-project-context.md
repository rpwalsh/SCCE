# Pinned OSS project context

Ordinary OSS ingestion follows a selected test's native compiler dependencies before publishing its source-owned contracts. Repository inspection and the linear file cursor keep their original snapshot identity. External declaration packages use separate registry source URIs and canonical source versions.

For offline initialization, provide one dependency manifest and its raw SHA256. Prepare its exact package archives and extracted files before initialization. No package installation or lifecycle scripts run. Missing cache bytes, changed lockfiles, wrong package integrity, and incomplete compiler context stop qualification with an actionable error.

```json
{
  "schema": "scce.oss_dependency_manifest.v1",
  "sourceSnapshotHash": "<original-repository-snapshot-sha256>",
  "packages": [
    {
      "lockfilePath": "package-lock.json",
      "lockfileContentHash": "sha256_<raw-lockfile-sha256>",
      "packageLocation": "node_modules/@types/example",
      "packageName": "@types/example",
      "version": "<exact-lockfile-version>",
      "archiveUri": "https://registry.npmjs.org/@types/example/-/example-<version>.tgz",
      "integrity": "sha512-<exact-lockfile-integrity>",
      "snapshotHash": "<verified-package-file-manifest-sha256>",
      "archivePath": "cache/example.tgz",
      "directoryPath": "cache/example"
    }
  ]
}
```

Cache paths are relative to the manifest directory and cannot traverse outside it. `packageLocation` is the exact lockfile key, including nested dependencies. The archive's complete file manifest establishes `snapshotHash`; this is separate from the repository's `sourceSnapshotHash`.

The builder validates all pins and cache files before creating a database:

```powershell
node --max-old-space-size=7168 tools/build-5gb-multicorpus-brain.mjs <initialization-options> --code-dependency-manifest offline/dependencies.json --code-dependency-manifest-hash <raw-manifest-sha256>
```

The existing OSS command forwards the same declaration to the same trainer:

```powershell
pnpm scce corpus train oss <repository> --dependency-manifest=offline/dependencies.json --dependency-manifest-hash=<raw-manifest-sha256>
```

Storage-free preflight is available through `loadOssDependencyManifest({path, contentHash, rootPath})`. It verifies the repository snapshot, manifest SHA256, lockfile identity, official registry archive SHA512, package identity, and every extracted file. `inspectPinnedPackageArchive` returns the verified package snapshot without writing or executing files.

Source buffers and canonical descriptors share the existing decoded-byte budget. Default file capacity comes from the declared inventory; explicit caller file limits remain binding. A selected project's qualified contracts and a completed sweep of all repository candidates are reported separately.
