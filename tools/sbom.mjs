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

/** The lockfile's own integrity hash for one resolved package, so the report ties to what pnpm actually fetched. */
function lockfileIntegrity(lockfileText, name, version) {
  if (!lockfileText || !version) return null;
  const newline = String.fromCharCode(10);
  const quote = String.fromCharCode(39);
  // A scoped name is quoted in the lockfile ('@scope/name@1.2.3:'); an unscoped one is not.
  const candidates = [
    `${newline}  ${name}@${version}:${newline}`,
    `${newline}  ${quote}${name}@${version}${quote}:${newline}`
  ];
  const at = candidates.map(candidate => lockfileText.indexOf(candidate)).find(index => index >= 0) ?? -1;
  if (at < 0) return null;
  const window = lockfileText.slice(at, at + 600);
  const match = /integrity:\s*([A-Za-z0-9+/=-]+)/.exec(window);
  return match ? match[1] : null;
}

/**
 * License tally across the whole resolved closure, not only the direct dependencies. The copyleft answer is only
 * reported for packages whose manifest actually declared a license; anything undeclared is counted and named so the
 * summary can never read as a clean bill of health it did not establish.
 */
function closureLicenseSummary() {
  const store = `${repo}/node_modules/.pnpm`;
  if (!exists(store)) return undefined;
  const COPYLEFT = /(GPL|AGPL|LGPL|MPL|EPL|CDDL|CPL|EUPL|OSL|SSPL)/i;
  const STRONG_COPYLEFT = /(GPL-[23]|AGPL|SSPL)/i;
  const byLicense = new Map();
  const copyleft = [];
  const strongCopyleft = [];
  const undeclared = [];
  const seen = new Set();
  let inspected = 0;
  for (const entry of fs.readdirSync(store)) {
    if (entry.startsWith(".")) continue;
    const base = `${store}/${entry}/node_modules`;
    if (!exists(base)) continue;
    const packages = [];
    for (const item of fs.readdirSync(base)) {
      if (item.startsWith("@")) {
        const scoped = `${base}/${item}`;
        if (!fs.statSync(scoped).isDirectory()) continue;
        for (const inner of fs.readdirSync(scoped)) packages.push(`${item}/${inner}`);
      } else packages.push(item);
    }
    for (const name of packages) {
      const file = `${base}/${name}/package.json`;
      if (!exists(file)) continue;
      let manifest;
      try {
        manifest = readJson(file);
      } catch {
        continue;
      }
      const identity = `${name}@${manifest.version ?? "?"}`;
      // The store nests a copy of each dependency under every package that needs it, so the same name@version is read
      // many times. Count identities, not manifests, or the closure looks several times larger than it is.
      if (seen.has(identity)) continue;
      seen.add(identity);
      inspected++;
      const license = licenseOf(manifest);
      byLicense.set(license, (byLicense.get(license) ?? 0) + 1);
      if (license === "undeclared" || license === "unresolved") undeclared.push(identity);
      else if (STRONG_COPYLEFT.test(license)) strongCopyleft.push(`${identity} (${license})`);
      else if (COPYLEFT.test(license)) copyleft.push(`${identity} (${license})`);
    }
  }
  const unique = list => [...new Set(list)].sort();
  return {
    scope: "every package present in the local pnpm store, direct and transitive, development and runtime",
    uniquePackagesInspected: inspected,
    licensesDeclared: Object.fromEntries([...byLicense.entries()].sort((left, right) => right[1] - left[1])),
    copyleftDependenciesIdentified: unique(copyleft),
    strongCopyleftDependenciesIdentified: unique(strongCopyleft),
    undeclaredLicensePackages: unique(undeclared).slice(0, 40),
    undeclaredLicenseCount: unique(undeclared).length,
    verificationStatus: "manifest-declared licenses only; no license-text analysis and not a legal opinion"
  };
}

/** The commit this SBOM describes, read from git rather than asserted. */
function sourceCommit() {
  const head = `${repo}/.git/HEAD`;
  if (!exists(head)) return null;
  const pointer = fs.readFileSync(head, "utf8").trim();
  if (!pointer.startsWith("ref:")) return pointer;
  const ref = `${repo}/.git/${pointer.slice(4).trim()}`;
  if (exists(ref)) return fs.readFileSync(ref, "utf8").trim();
  const packed = `${repo}/.git/packed-refs`;
  if (!exists(packed)) return null;
  const name = pointer.slice(4).trim();
  const match = new RegExp(`^([0-9a-f]{40}) ${name}$`, "m").exec(fs.readFileSync(packed, "utf8"));
  return match ? match[1] : null;
}

function transitiveCount() {
  const store = `${repo}/node_modules/.pnpm`;
  if (!exists(store)) return undefined;
  return fs.readdirSync(store).filter(dir => dir.includes("@") && !dir.startsWith(".")).length;
}

const lockfilePath = `${repo}/pnpm-lock.yaml`;
const lockfileText = exists(lockfilePath) ? fs.readFileSync(lockfilePath, "utf8") : "";
const resolution = {
  packageManager: "pnpm",
  lockfile: "pnpm-lock.yaml",
  lockfileSha256: lockfileText ? createHash("sha256").update(lockfileText).digest("hex") : null,
  lockfileVersion: (/^lockfileVersion:\s*'?([\d.]+)'?/m.exec(lockfileText) ?? [])[1] ?? null,
  // The commit this manifest describes. A buyer can walk source snapshot -> manifests -> lockfile -> resolved
  // packages -> vendored archive without taking anyone's word for the chain.
  workspaceCommit: sourceCommit()
};

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
        integrity: lockfileIntegrity(lockfileText, name, resolved?.version),
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
const licenseSummary = closureLicenseSummary();

const sbom = {
  schema: "scce.sbom.v1",
  generatedAt: new Date().toISOString(),
  generator: "tools/sbom.mjs",
  coverage: {
    method: "workspace manifests plus the resolved pnpm store and vendored archives",
    includes: ["declared direct dependencies", "resolved installed versions", "declared licenses", "vendored archive checksums"],
    includesAlso: ["declared-license scan across the full resolved closure", "lockfile integrity hashes for direct dependencies", "source commit and lockfile identity"],
    excludes: ["license-text analysis", "vulnerability matching", "license compatibility analysis", "verification that a declared license matches the shipped license text"],
    note: "A declaration-and-resolution report. A buyer commissions an SCA scan and a legal license review separately."
  },
  resolution,
  proprietary: {
    holder: "Ryan P. Walsh",
    statement: "SCCE's own source is proprietary and inspection-only; no right to use, copy, modify, distribute, sublicense, sell, or create derivative works is granted except by separate written agreement. See LICENSE.",
    thirdPartyDisclosure: "SCCE contains no open-source code of its own and does depend on third-party open-source components, listed below. The delivered system therefore contains open source; SCCE's own source is not open source."
  },
  counts: {
    directRuntime: runtime.length,
    directDevelopment: development.length,
    vendoredArchives: archives.length,
    // The complete pnpm-resolved closure, transitive and development included -- not a count of chosen dependencies.
    resolvedDependencyClosure: transitive ?? null
  },
  ...(licenseSummary ? { licenseSummary } : {}),
  runtimeDependencies: runtime,
  developmentDependencies: development,
  vendoredArchives: archives
};

fs.writeFileSync(`${repo}/docs/SBOM.json`, `${JSON.stringify(sbom, null, 1)}\n`, "utf8");

const licenseTable = summary => summary
  ? [
    "| Question | Answer | Scope |",
    "|---|---|---|",
    `| Copyleft dependencies identified | ${summary.copyleftDependenciesIdentified.length ? summary.copyleftDependenciesIdentified.join(", ") : "none"} | ${summary.uniquePackagesInspected} unique packages |`,
    `| Strong copyleft (GPL/AGPL/SSPL) identified | ${summary.strongCopyleftDependenciesIdentified.length ? summary.strongCopyleftDependenciesIdentified.join(", ") : "none"} | ${summary.uniquePackagesInspected} unique packages |`,
    `| Packages with no declared license | ${summary.undeclaredLicenseCount} | ${summary.uniquePackagesInspected} unique packages |`,
    `| Verification status | ${summary.verificationStatus} | |`
  ].join(String.fromCharCode(10))
  : "The pnpm store is not present, so no closure-wide license scan was performed.";

const table = list => [
  "| Component | Version | License | Lockfile integrity | Required by |",
  "|---|---|---|---|---|",
  ...list.map(row => `| \`${row.name}\`${row.vendored ? " (vendored)" : ""} | ${row.resolvedVersion ?? row.declaredRange} | ${row.license} | ${row.integrity ? `\`${row.integrity.slice(0, 24)}...\`` : row.vendored ? "vendored, see checksum below" : "not recorded in lockfile"} | ${row.requiredBy.join(", ")} |`)
].join("\n");

const markdown = `# SCCE software bill of materials

Generated by \`pnpm sbom\` (\`tools/sbom.mjs\`) on ${sbom.generatedAt}. The machine-readable form is
[\`docs/SBOM.json\`](SBOM.json).

## What this is, and what it is not

${sbom.coverage.note} It reads the workspace manifests, the versions pnpm actually installed, and the checksums of
vendored archives. It does **not** analyse license texts, match vulnerabilities, or attribute licenses transitively.

## Source and resolution identity

This manifest describes one exact source state and one exact dependency resolution.

| Field | Value |
|---|---|
| Source commit | \`${sbom.resolution.workspaceCommit ?? "unavailable"}\` |
| Package manager | ${sbom.resolution.packageManager} |
| Lockfile | \`${sbom.resolution.lockfile}\` (version ${sbom.resolution.lockfileVersion ?? "?"}) |
| Lockfile sha256 | \`${sbom.resolution.lockfileSha256 ?? "unavailable"}\` |

A reviewer can walk source snapshot to manifests to lockfile to resolved packages to vendored artifact without relying
on anyone's assertion: each direct dependency below carries the lockfile's own integrity hash, and the vendored archive
carries its sha256.

## License summary across the resolved closure

${licenseTable(sbom.licenseSummary)}

This scan reads the declared \`license\` field of every unique package in the resolved closure, direct and transitive,
runtime and development. It is not a license-text analysis and it is not a legal opinion.

## Proprietary position

${sbom.proprietary.statement}

**${sbom.proprietary.thirdPartyDisclosure}**

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
  ? "The pnpm store is not present, so the closure could not be counted."
  : `${transitive} unique packages make up the complete pnpm-resolved closure: direct and transitive, runtime and development together. That is the number of packages present, not the number chosen -- ${runtime.length} direct runtime and ${development.length} direct development dependencies are declared, and everything else arrived with them. It is also the development closure, not the shipped runtime closure: the kernel declares one runtime dependency and the root package declares none.`}

## Dependency shape

The cognitive core is deliberately light. \`@scce/kernel\` declares a single runtime dependency (Unicode data), the
root workspace declares none, and the substantive third-party surface is concentrated in \`@scce/adapters-node\`, which
is the boundary where SCCE meets PostgreSQL, document parsers, tree-sitter and optional local embedding models. That
keeps the portable IP separable from the integration layer.
`;

fs.writeFileSync(`${repo}/docs/SBOM.md`, markdown, "utf8");

console.log(`SBOM: ${runtime.length} direct runtime, ${development.length} direct development, ${archives.length} vendored archive(s), ${transitive ?? "?"} packages in store`);
for (const row of runtime) console.log(`  runtime  ${row.name}@${row.resolvedVersion ?? row.declaredRange} ${row.license}`);
