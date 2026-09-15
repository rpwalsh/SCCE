import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireAndTrainGithubOssRepository,
  validateGithubCommitSha,
  validateGithubPublicRepositoryUrl,
  type GithubOssAcquisitionOptions
} from "../github-oss-acquisition.js";
import type { OssCorpusTrainOptions, OssCorpusTrainReport } from "../oss-corpus.js";
import type { ScceStorage } from "@scce/kernel";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

beforeEach(() => vi.stubEnv("SCCE_ALLOW_AUTOMATIC_WEB", "1"));
afterEach(() => vi.unstubAllEnvs());

describe("public GitHub OSS acquisition", () => {
  it("refuses before materialization when the public-network opt-in is absent", async () => {
    vi.unstubAllEnvs();
    const materializeSnapshot = vi.fn(async () => undefined);
    await expect(acquireAndTrainGithubOssRepository({
      storage: {} as ScceStorage,
      remoteUrl: "https://github.com/example/project",
      commitSha: COMMIT,
      materializeSnapshot
    })).rejects.toThrow(/public GitHub acquisition refused/iu);
    expect(materializeSnapshot).not.toHaveBeenCalled();
  });

  it("accepts only a public repository URL and a pinned commit", () => {
    expect(validateGithubPublicRepositoryUrl("https://github.com/example/project")).toBe("https://github.com/example/project.git");
    expect(validateGithubPublicRepositoryUrl("https://github.com/example/project.git/")).toBe("https://github.com/example/project.git");
    expect(validateGithubCommitSha(COMMIT)).toBe(COMMIT);
    expect(() => validateGithubPublicRepositoryUrl("file:///tmp/project")).toThrow(/public https/iu);
    expect(() => validateGithubPublicRepositoryUrl("https://user:secret@github.com/example/project")).toThrow(/credentials/iu);
    expect(() => validateGithubPublicRepositoryUrl("https://github.com/example/project/issues")).toThrow(/exactly one/iu);
    expect(() => validateGithubCommitSha("HEAD")).toThrow(/40-character/iu);
  });

  it("inventorys a materialized pinned snapshot, preserves hashes/provenance, and delegates to the OSS trainer", async () => {
    let received: OssCorpusTrainOptions | undefined;
    let materializedRoot = "";
    const input: GithubOssAcquisitionOptions = {
      storage: {} as ScceStorage,
      remoteUrl: "https://github.com/example/project",
      commitSha: COMMIT,
      bounds: { maxFiles: 4, maxFileBytes: 1000, maxTotalBytes: 2000, maxDepth: 4 },
      materializeSnapshot: async ({ rootPath }) => {
        materializedRoot = rootPath;
        await mkdir(path.join(rootPath, "src"), { recursive: true });
        await writeFile(path.join(rootPath, "README.md"), "public docs\n", "utf8");
        await writeFile(path.join(rootPath, "src", "main.ts"), "export const answer = 42;\n", "utf8");
      },
      trainCorpus: async options => {
        received = options;
        return emptyReport(options.rootPath);
      }
    };

    const report = await acquireAndTrainGithubOssRepository(input);
    expect(report.remoteUrl).toBe("https://github.com/example/project.git");
    expect(report.commitSha).toBe(COMMIT);
    expect(report.files.map(file => file.path)).toEqual(["README.md", "src/main.ts"]);
    expect(report.files.every(file => /^[0-9a-f]{64}$/u.test(file.contentHash))).toBe(true);
    expect(report.provenance.fileHashes["src/main.ts"]).toBe(report.files.find(file => file.path === "src/main.ts")?.contentHash);
    expect(received?.repositoryProvenance).toEqual(report.provenance);
    expect(received?.sourceUriBase).toContain(`/tree/${COMMIT}`);
    expect(received?.rootPath).toBe(materializedRoot);
    await expect(readFile(path.join(materializedRoot, "README.md"), "utf8")).rejects.toThrow();
  });

  it("rejects a snapshot before training when configured byte bounds are exceeded", async () => {
    let trained = false;
    await expect(acquireAndTrainGithubOssRepository({
      storage: {} as ScceStorage,
      remoteUrl: "https://github.com/example/project",
      commitSha: COMMIT,
      bounds: { maxTotalBytes: 3 },
      materializeSnapshot: async ({ rootPath }) => {
        await writeFile(path.join(rootPath, "README.md"), "too large\n", "utf8");
      },
      trainCorpus: async options => {
        trained = true;
        return emptyReport(options.rootPath);
      }
    })).rejects.toThrow(/maxTotalBytes/iu);
    expect(trained).toBe(false);
  });
});

function emptyReport(rootPath: string): OssCorpusTrainReport {
  const totals = { languageProfiles: 0, evidence: 0, ngramObservations: 0, ngramModels: 0, languageUnits: 0, languagePatterns: 0, semanticFrames: 0, constructionCandidates: 0, languageConstructions: 0, rejectedLanguageConstructions: 0 };
  return {
    schema: "scce.ossCorpusTrainReport.v1",
    rootPath,
    docsTrained: 0,
    codeTrained: 0,
    filesSkipped: [],
    totals: { oss_docs: totals, oss_code: totals },
    reports: [],
    stoppedByHeapSafetyBound: false,
    heapMiBAtExit: 0
  };
}
