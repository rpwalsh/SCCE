# Vendored Dependencies

The `vendor` directory holds immutable upstream distribution artifacts required for reproducible, offline installation. A vendored archive is still third-party code; vendoring does not by itself make the code trusted or sandboxed.

## SheetJS Community Edition 0.20.3

| Field | Value |
| --- | --- |
| File | `xlsx-0.20.3.tgz` |
| Package | `xlsx` |
| Version | `0.20.3` |
| Official URL | `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` |
| SHA-256 | `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8` |
| License | Apache License 2.0 |
| Attribution | `xlsx.js (C) 2013-present SheetJS` |

SheetJS identifies its CDN as the authoritative package source and recommends vendoring for installation stability. The archive is referenced as `file:../../vendor/xlsx-0.20.3.tgz` by `packages/adapters-node/package.json`; `pnpm-lock.yaml` pins the local package integrity.

The upstream license text is present inside the tarball at `package/LICENSE` and `package/dist/LICENSE`. Repository-level attribution is recorded in [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## Verify the archive

PowerShell:

```powershell
(Get-FileHash -Algorithm SHA256 -LiteralPath vendor/xlsx-0.20.3.tgz).Hash.ToLowerInvariant()
```

POSIX shell:

```sh
sha256sum vendor/xlsx-0.20.3.tgz
```

The result must be exactly:

```text
8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8
```

Do not install or review the archive as if its filename were sufficient provenance. A checksum mismatch is a hard failure.

## Replacement procedure

Changing the archive is a dependency upgrade, not a routine refresh.

1. Download the selected release from the official SheetJS CDN.
2. Verify the version in `package/package.json`, the attribution header, and the bundled license before use.
3. Compute and independently record the SHA-256 digest.
4. Update the local dependency reference, lockfile, this file, and [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
5. Re-run the spreadsheet tests, the package build, the full validation gate, and the dependency audit.
6. Review the parser integration and its resource/security assumptions; do not assume a compatible API or equivalent behavior from a new version.

Yopp's parser process, archive preflight, limits, and fail-closed behavior are defined in [`../docs/SPREADSHEET_INGESTION_CONTRACT.md`](../docs/SPREADSHEET_INGESTION_CONTRACT.md). The child process is a killable isolation boundary with explicit V8 flags, not an operating-system sandbox or cgroup memory ceiling.
