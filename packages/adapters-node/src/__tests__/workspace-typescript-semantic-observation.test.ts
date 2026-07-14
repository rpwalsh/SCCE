import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type WorkspaceRecord,
  type WorkspaceSourceFileRecord,
  type WorkspaceStore
} from "@scce/kernel";
import type { ScceRuntimeConfig } from "../config.js";
import {
  TYPESCRIPT_SEMANTIC_PROGRAM_INDEX_SCHEMA,
  createWorkspaceRuntime
} from "../index.js";
import type { NodeScceRuntime } from "../runtime.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("workspace TypeScript semantic observation", () => {
  it("carries compiler semantics through the canonical observation with an exact durable revision binding", async () => {
    const fixture = await durableTypeScriptFixture();
    const runtime = createWorkspaceRuntime({
      runtime: fakeRuntime(fixture.store),
      config: fixtureConfig(fixture.root)
    });
    const request = {
      workspaceId: fixture.workspace.id,
      expectedWorkspaceUpdatedAt: fixture.workspace.updatedAt,
      tsconfigPath: "tsconfig.json",
      bounds: {
        workspacePaths: fixture.paths,
        observedTestPaths: ["checks/use.case.ts"],
        maxFiles: 16,
        maxFileBytes: 64 * 1024,
        maxTotalBytes: 512 * 1024
      }
    } as const;

    const first = await runtime.observeTypeScript(request, fixture.root);
    const second = await runtime.observeTypeScript(request, fixture.root);

    expect(first.schema).toBe("scce.workspace_kernel.semantic_program_observation.v1");
    expect(first.program.schemaVersion).toBe(TYPESCRIPT_SEMANTIC_PROGRAM_INDEX_SCHEMA);
    expect(first.workspaceRevision).toMatchObject({
      workspaceId: fixture.workspace.id,
      revisionId: `${fixture.workspace.id}:${fixture.workspace.updatedAt}`,
      workspaceUpdatedAt: fixture.workspace.updatedAt
    });
    expect(first.workspaceRevision.revisionHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.semanticRevisionHash).toBe(first.program.revisionHash);
    expect(first.execution).toEqual({ state: "not_executed" });
    expect(second.id).toBe(first.id);
    expect(second.workspaceRevision.revisionHash).toBe(first.workspaceRevision.revisionHash);
    expect(second.semanticRevisionHash).toBe(first.semanticRevisionHash);

    const target = first.program.symbols.find(symbol => symbol.nameEvidence === "target"
      && symbol.declarationIds.some(id => first.program.declarations.find(declaration => declaration.id === id)?.span.path === "src/target.ts"));
    expect(target).toBeDefined();
    expect(first.program.references.some(reference => reference.targetSymbolId === target!.id && reference.span.path === "src/use.ts")).toBe(true);
    expect(first.program.calls.some(call => call.targetSymbolId === target!.id && call.span.path === "src/use.ts")).toBe(true);
    expect(first.program.diagnostics).toContainEqual(expect.objectContaining({
      compilerCode: 2322,
      span: expect.objectContaining({ path: "src/use.ts" })
    }));
    expect(first.program.testRelations).toContainEqual(expect.objectContaining({
      kindId: "scce.rel.program.test_call.v1",
      targetSymbolId: target!.id
    }));
    expect(first.program.commands).toContainEqual(expect.objectContaining({
      sourceNameEvidence: "compile",
      rawCommandEvidence: "tsc -p tsconfig.json"
    }));

    const durableHashByPath = new Map(fixture.sources.map(source => [source.path, hashDigest(String(source.contentHash))]));
    for (const file of first.program.files) {
      expect(hashDigest(file.contentHash)).toBe(durableHashByPath.get(file.path));
    }

    await writeFile(path.join(fixture.root, "src", "target.ts"), "export const target = (value: string): string => value.toUpperCase();\n", "utf8");
    await expect(runtime.observeTypeScript(request, fixture.root)).rejects.toThrow(/stale durable workspace bytes/u);
  });
});

async function durableTypeScriptFixture(): Promise<{
  root: string;
  workspace: WorkspaceRecord;
  paths: string[];
  sources: WorkspaceSourceFileRecord[];
  store: MemoryWorkspaceStore;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "scce-workspace-ts-observation-"));
  temporaryRoots.push(root);
  const entries: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "workspace-semantic-observation",
      type: "module",
      scripts: { compile: "tsc -p tsconfig.json" }
    }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true
      },
      include: ["src/**/*.ts", "checks/**/*.ts"]
    }),
    "src/target.ts": "export const target = (value: string): string => value;\n",
    "src/use.ts": "import { target } from \"./target.js\";\nexport const output = target(\"value\");\nexport const broken: string = 42;\n",
    "checks/use.case.ts": "import { target } from \"../src/target.js\";\nexport const observed = target(\"case\");\n"
  };
  for (const [workspacePath, content] of Object.entries(entries)) {
    const absolutePath = path.join(root, ...workspacePath.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  const workspace: WorkspaceRecord = {
    id: "workspace.semantic-observation-test",
    rootPath: root,
    rootUri: `file://${root.split(path.sep).join("/")}`,
    corpusId: "corpus.semantic-observation-test",
    status: "active",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    metadata: {}
  };
  const paths = Object.keys(entries).sort();
  const sources: WorkspaceSourceFileRecord[] = paths.map(workspacePath => {
    const content = entries[workspacePath]!;
    return {
      workspaceId: workspace.id,
      corpusId: workspace.corpusId,
      path: workspacePath,
      absolutePath: path.join(root, ...workspacePath.split("/")),
      mediaType: workspacePath.endsWith(".json") ? "application/json" : "text/typescript",
      contentHash: durableHash(content) as WorkspaceSourceFileRecord["contentHash"],
      modifiedTime: workspace.updatedAt,
      byteLength: Buffer.byteLength(content, "utf8"),
      ingestionStatus: "ingested",
      importBatchId: "import.semantic-observation-test",
      evidenceIds: [],
      symbolIds: [],
      conceptIds: [],
      warnings: [],
      errors: [],
      metadata: {},
      updatedAt: workspace.updatedAt
    };
  });
  const store = new MemoryWorkspaceStore(workspace, sources);
  return { root, workspace, paths, sources, store };
}

class MemoryWorkspaceStore implements WorkspaceStore {
  constructor(
    private readonly workspace: WorkspaceRecord,
    private readonly sources: readonly WorkspaceSourceFileRecord[]
  ) {}

  async putWorkspace(): Promise<void> {}
  async getWorkspace(id: string): Promise<WorkspaceRecord | null> {
    return id === this.workspace.id ? this.workspace : null;
  }
  async latestWorkspace(): Promise<WorkspaceRecord | null> {
    return this.workspace;
  }
  async putSourceFile(): Promise<void> {}
  async listSourceFiles(query: { workspaceId?: string; limit?: number } = {}): Promise<WorkspaceSourceFileRecord[]> {
    if (query.workspaceId && query.workspaceId !== this.workspace.id) return [];
    return [...this.sources].slice(0, query.limit ?? this.sources.length);
  }
  async putReport(): Promise<void> {}
  async listReports(): Promise<[]> {
    return [];
  }
}

function fakeRuntime(workspace: WorkspaceStore): NodeScceRuntime {
  return {
    storage: { workspace } as NodeScceRuntime["storage"],
    kernel: {} as NodeScceRuntime["kernel"],
    connectors: {} as NodeScceRuntime["connectors"],
    approvals: {} as NodeScceRuntime["approvals"],
    close: async () => {}
  };
}

function fixtureConfig(root: string): ScceRuntimeConfig {
  return {
    server: { url: "http://127.0.0.1:0" },
    database: { url: "postgres://example/example", schema: "public" },
    runtime: {
      workspaceRoot: root,
      tempRoot: path.join(root, ".tmp"),
      maxFileBytes: 1024 * 1024,
      maxChunkBytes: 64 * 1024,
      allowedRoots: [root],
      excludedPaths: [],
      tools: {}
    },
    connectors: {},
    policy: {
      allowMutation: false,
      requireTwoPhaseCommit: true,
      dryRunByDefault: true,
      maxNetworkRequests: 0,
      maxToolCalls: 0,
      maxSpendCents: 0,
      alphaRiskCeiling: 0.5,
      encryptSecretsAtRest: true
    }
  };
}

function durableHash(content: string): string {
  return `sha256_${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function hashDigest(value: string): string {
  return value.replace(/^sha256[:_]/u, "");
}
