#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Generates docs/SBOM.json and docs/SBOM.md: every third-party component this repository declares or vendors, with the
// resolved version, declared license, source, and the SCCE package that depends on it. Direct dependencies are listed
// with their transitive closure counted separately, because a buyer's counsel asks two different questions -- what did
// you choose, and what came with it.
//
// This is a declaration-and-resolution report, not a scanner: it reads the workspace manifests, the installed pnpm
// store, and the vendored archives. It does not attempt license-text analysis or vulnerability matching, both of which
// a buyer commissions separately. It says so in its own output rather than implying more coverage than it has.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const repo = process.cwd().split(String.fromCharCode(92)).join("/");
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
const exists = file => fs.existsSync(file);

function workspaceManifests() {
  const manifests = [{ id: "scce-v3", file: "package.json" }];
  for (const entry of fs.readdirSync(`${repo}/packages`, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = `packages/${entry.name}/package.json`;
    if (exists(`${repo}/${file}`)) manifests.push({ id: `@scce/${entry.name}`, file });
  }
  for (const file of ["tools/sealed-eval/package.json"]) if (exists(`${repo}/${file}`)) manifests.push({ id: file, file });
  return manifests;
}

/** The resolved package as pnpm actually installed it, so the report states what is on disk rather than a range. */
function resolvedPackage(name) {
  const direct = `${repo}/node_modules/${name}/package.json`;
  if (exists(direct)) return readJson(direct);
  const store = `${repo}/node_modules/.pnpm`;
  if (!exists(store)) return undefined;
  const flattened = name.replace("/", "+");
  const candidates = fs.readdirSync(store).filter(dir => dir.startsWith(`${flattened}@`));
  for (const candidate of candidates.sort()) {
    const file = `${store}/${candidate}/node_modules/${name}/package.json`;
    if (exists(file)) return readJson(file);
  }
  return undefined;
}

function licenseOf(manifest) {
  if (!manifest) return "unresolved";
  if (typeof manifest.license === "string") return manifest.license;
  if (Array.isArray(manifest.licenses) && manifest.licenses[0]?.type) return manifest.licenses[0].type;
  return "undeclared";
}

function repositoryOf(manifest) {
  const repository = manifest?.repository;
  if (!repository) return "";
  return typeof repository === "string" ? repository : String(repository.url ?? "");
}

function vendoredArchives() {
  const dir = `${repo}/vendor`;
  if (!exists(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => name.endsWith(".tgz") || name.endsWith(".zip"))
    .map(name => {
      const file = `${dir}/${name}`;
      const bytes = fs.readFileSync(file);
      return {
        file: `vendor/${name}`,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex")
      };
    });
}

function transitiveCount() {
  const store = `${repo}/node_modules/.pnpm`;
  if (!exists(store)) return undefined;
  return fs.readdirSync(store).filter(dir => dir.includes("@") && !dir.startsWith(".")).length;
}

const components = new Map();
for (const manifest of workspaceManifests()) {
  const declared = readJson(`${repo}/${manifest.file}`);
  for (const [scope, group] of [["runtime", declared.dependencies], ["development", declared.devDependencies]]) {
    for (const [name, range] of Object.entries(group ?? {})) {
      if (String(range).startsWith("workspace:")) continue;
      const resolved = resolvedPackage(name);
      const key = `${name}|${scope}`;
      const existing = components.get(key);
      if (existing) {
        existing.requiredBy.push(manifest.id);
        continue;
      }
      components.set(key, {
        name,
        scope,
        declaredRange: String(range),
        resolvedVersion: resolved?.version ?? null,
        license: licenseOf(resolved),
        repository: repositoryOf(resolved),
        vendored: String(range).startsWith("file:"),
        requiredBy: [manifest.id]
      });
    }
  }
}

const rows = [...components.values()].sort((left, right) =>
  left.scope.localeCompare(right.scope) || left.name.localeCompare(right.name));
const runtime = rows.filter(row => row.scope === "runtime");
const development = rows.filter(row => row.scope === "development");
const archives = vendoredArchives();
const transitive = transitiveCount();

const sbom = {
  schema: "scce.sbom.v1",
  generatedAt: new Date().toISOString(),
  generator: "tools/sbom.mjs",
  coverage: {
    method: "workspace manifests plus the resolved pnpm store and vendored archives",
    includes: ["declared direct dependencies", "resolved installed versions", "declared licenses", "vendored archive checksums"],
    excludes: ["license-text analysis", "vulnerability matching", "transitive per-package license attribution"],
    note: "A declaration-and-resolution report. A buyer commissions an SCA scan and a legal license review separately."
  },
  proprietary: {
    holder: "Ryan P. Walsh",
    statement: "SCCE's own source is proprietary and inspection-only; no right to use, copy, modify, distribute, sublicense, sell, or create derivative works is granted except by separate written agreement. See LICENSE.",
    correction: "SCCE contains no open-source code of its own, and it does depend on third-party open-source components, listed below. 'Zero open source' is not an accurate description of the delivered system."
  },
  counts: {
    directRuntime: runtime.length,
    directDevelopment: development.length,
    vendoredArchives: archives.length,
    installedPackagesInStore: transitive ?? null
  },
  runtimeDependencies: runtime,
  developmentDependencies: development,
  vendoredArchives: archives
};

fs.writeFileSync(`${repo}/docs/SBOM.json`, `${JSON.stringify(sbom, null, 1)}\n`, "utf8");

const table = list => [
  "| Component | Version | License | Scope | Required by |",
  "|---|---|---|---|---|",
  ...list.map(row => `| \`${row.name}\`${row.vendored ? " (vendored)" : ""} | ${row.resolvedVersion ?? row.declaredRange} | ${row.license} | ${row.scope} | ${row.requiredBy.join(", ")} |`)
].join("\n");

const markdown = `# SCCE software bill of materials

Generated by \`pnpm sbom\` (\`tools/sbom.mjs\`) on ${sbom.generatedAt}. The machine-readable form is
[\`docs/SBOM.json\`](SBOM.json).

## What this is, and what it is not

${sbom.coverage.note} It reads the workspace manifests, the versions pnpm actually installed, and the checksums of
vendored archives. It does **not** analyse license texts, match vulnerabilities, or attribute licenses transitively.

## Proprietary position

${sbom.proprietary.statement}

**${sbom.proprietary.correction}**

## Direct runtime dependencies (${runtime.length})

${table(runtime)}

## Direct development dependencies (${development.length})

${table(development)}

## Vendored archives (${archives.length})

${archives.length
  ? ["| File | Bytes | sha256 |", "|---|---|---|", ...archives.map(row => `| \`${row.file}\` | ${row.bytes} | \`${row.sha256}\` |`)].join("\n")
  : "None."}

## Transitive closure

${transitive === undefined
  ? "The pnpm store is not present, so the installed closure could not be counted."
  : `${transitive} packages are present in the local pnpm store. That number is the development closure, not the shipped runtime closure: the kernel declares one runtime dependency and the root package declares none.`}

## Dependency shape

The cognitive core is deliberately light. \`@scce/kernel\` declares a single runtime dependency (Unicode data), the
root workspace declares none, and the substantive third-party surface is concentrated in \`@scce/adapters-node\`, which
is the boundary where SCCE meets PostgreSQL, document parsers, tree-sitter and optional local embedding models. That
keeps the portable IP separable from the integration layer.
`;

fs.writeFileSync(`${repo}/docs/SBOM.md`, markdown, "utf8");

console.log(`SBOM: ${runtime.length} direct runtime, ${development.length} direct development, ${archives.length} vendored archive(s), ${transitive ?? "?"} packages in store`);
for (const row of runtime) console.log(`  runtime  ${row.name}@${row.resolvedVersion ?? row.declaredRange} ${row.license}`);
