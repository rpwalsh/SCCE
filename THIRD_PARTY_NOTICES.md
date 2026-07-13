# Third-Party Notices

This repository includes third-party software. The notices below do not replace or modify the applicable upstream license terms.

## SheetJS Community Edition

- Component: `xlsx`
- Version: `0.20.3`
- Project: [SheetJS Community Edition](https://sheetjs.com/)
- Official source archive: [https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz](https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz)
- Vendored archive: [`vendor/xlsx-0.20.3.tgz`](vendor/xlsx-0.20.3.tgz)
- SHA-256: `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`
- License: Apache License 2.0
- Upstream attribution: `xlsx.js (C) 2013-present SheetJS`

The vendored tarball is the official upstream distribution archive and is stored without source modifications. It contains the complete Apache License 2.0 text at `package/LICENSE` and `package/dist/LICENSE`. The upstream archive contains no separate `NOTICE` file.

The Apache License 2.0 is also available at [https://www.apache.org/licenses/LICENSE-2.0](https://www.apache.org/licenses/LICENSE-2.0).

Yopp resolves the `xlsx` dependency from the local archive through `packages/adapters-node/package.json`. See [`vendor/README.md`](vendor/README.md) for checksum verification and [`docs/SPREADSHEET_INGESTION_CONTRACT.md`](docs/SPREADSHEET_INGESTION_CONTRACT.md) for the bounded ingestion contract around this library.
