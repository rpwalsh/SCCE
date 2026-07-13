import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GRAPH_QUALITY_REASON_IDS, QUESTION_EDGE_DECISION_IDS, type ScceStorage } from "@scce/kernel";
import {
  classifyV2ArtifactPath,
  inspectV2Artifacts,
  inspectV2Profile,
  inspectV2Stream,
  inspectV2StreamTopic,
  inspectV2Topic
} from "../scce2/v2-artifact-inspector.js";

describe("v2 artifact inspector", () => {
  it("classifies profile shards as language priors, not corpus or graph knowledge", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scce-v2-artifacts-"));
    try {
      const profilePath = path.join(root, "language-profiles", "wiki-stream", "language-shard-0001.profile.json");
      await mkdir(path.dirname(profilePath), { recursive: true });
      await writeJson(profilePath, {
        schema: "scce.learnedLanguageProfileShard.v1",
        sourceId: "wiki-stream",
        shardId: "language-shard-0001",
        languageId: "lang.synthetic",
        script: "Latn",
        tokenizationProfile: {
          observedSymbols: [{ value: "Ada", count: 2 }],
          observedTitleTokens: [{ value: "Ada", count: 1 }]
        },
        fileEvidence: [
          { id: "profile-only", title: "Ada Lovelace", excerpt: "Ada Lovelace {{dirty}} [[markup]]" }
        ]
      });

      const inspected = await inspectV2Artifacts(root, { hashWorkExtentBytes: 1024 * 1024, maxHashBytesPerFile: 1024 * 1024 });
      expect(inspected.totals.byKind.v2_language_profile).toBe(1);
      expect(inspected.languageMemory).toHaveLength(1);
      expect(inspected.graphMemory).toHaveLength(0);
      expect(inspected.corpusSourceMemory).toHaveLength(0);
      expect(inspected.languageMemory[0]?.forceClass).toBe("learned_language_prior");

      const profile = await inspectV2Profile(profilePath);
      expect(profile.qualityGate.directSourceSpanAvailability).toBe(0);
      expect(profile.forceClasses).not.toContain("direct_evidence");
      expect(profile.warnings.join(" ")).toContain("cannot become direct evidence");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies graph shards, n-gram files, stream corpora, and lookups into distinct roles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scce-v2-roles-"));
    try {
      const graph = path.join(root, "brain-shards", "wiki-stream", "shard-000001.v8");
      const ngram = path.join(root, "models", "ngram", "hexagram-prose.v8");
      const codeNgram = path.join(root, "models", "ngram", "hexagram-code.bin");
      const stream = path.join(root, "wiki-stream", "enwiki-latest-pages-articles-multistream.xml.bz2");
      const lookup = path.join(root, "wiki-stream", "enwiki-latest-pages-articles-multistream-index.txt");
      await mkdir(path.dirname(graph), { recursive: true });
      await mkdir(path.dirname(ngram), { recursive: true });
      await mkdir(path.dirname(stream), { recursive: true });
      await writeFile(graph, Buffer.concat([Buffer.from("SCCECGV8"), Buffer.from([0, 1]), Buffer.from("synthetic")]));
      await writeFile(ngram, Buffer.concat([Buffer.from("SCCEV8"), Buffer.from([0, 1]), Buffer.from("synthetic")]));
      await writeFile(codeNgram, Buffer.from("SCCE code model"));
      await writeFile(stream, Buffer.from("compressed stream placeholder"));
      await writeFile(lookup, "123:456:Ada Lovelace\n789:111:Albert Einstein\n", "utf8");

      const inspected = await inspectV2Artifacts(root, { hashWorkExtentBytes: 0, maxHashBytesPerFile: 0 });
      expect(inspected.totals.byKind.v2_concept_graph_v8).toBe(1);
      expect(inspected.totals.byKind.v2_ngram_model).toBe(2);
      expect(inspected.totals.byKind.v2_stream_corpus).toBe(1);
      expect(inspected.totals.byKind.v2_stream_lookup).toBe(1);
      expect(inspected.graphMemory[0]?.forceClass).toBe("learned_concept_prior");
      expect(inspected.languageMemory.some(file => file.forceClass === "learned_language_prior")).toBe(true);
      expect(inspected.languageMemory.some(file => file.forceClass === "learned_program_prior")).toBe(true);
      expect(inspected.corpusSourceMemory.every(file => file.importDecision === "route_to_stream_corpus_ingestor")).toBe(true);

      const streamInspect = await inspectV2Stream(path.join(root, "wiki-stream"), { hashWorkExtentBytes: 0, maxHashBytesPerFile: 0 });
      expect(streamInspect.status).toBe("stream_corpus_and_lookup_present");
      expect(streamInspect.destinationTables).toContain("source_versions");
      expect(streamInspect.destinationTables).toContain("evidence_spans");

      const topic = await inspectV2StreamTopic("Ada Lovelace", [lookup]);
      expect(topic.status).toBe("resolved_in_lookup");
      expect(topic.matches[0]?.title).toContain("Ada Lovelace");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps n-gram files as continuation statistics instead of factual memory", () => {
    const prose = classifyV2ArtifactPath(path.join("models", "ngram", "hexagram-prose.v8"), "SCCEV8");
    const code = classifyV2ArtifactPath(path.join("models", "ngram", "hexagram-code.bin"), "");
    expect(prose.kind).toBe("v2_ngram_model");
    expect(prose.forceClass).toBe("learned_language_prior");
    expect(prose.destinationTables).toContain("ngram_observations");
    expect(prose.destinationTables).not.toContain("graph_nodes");
    expect(code.forceClass).toBe("learned_program_prior");
  });

  it("exposes hydrated topic support state without letting language-only support certify facts", async () => {
    const storage = fakePostgresStorage({
      nodes: [
        { id: "node.einstein", representation_json: { label: "Albert Einstein" }, alpha: 0.7, metadata_json: { forceClass: "learned_concept_prior" } }
      ],
      edges: [
        {
          id: "edge.einstein.field",
          relation_id: "relation.person.field",
          weight: 0.9,
          alpha: 0.6,
          metadata_json: { relation: { subject: "Albert Einstein", predicate: "field", object: "physics" }, forceClass: "learned_concept_prior" }
        },
        {
          id: "edge.einstein.profession",
          relation_id: "relation.person.profession",
          weight: 0.9,
          alpha: 0.6,
          metadata_json: { relation: { subject: "Albert Einstein", predicate: "profession", object: "physicist" }, forceClass: "learned_concept_prior" }
        }
      ],
      languageCount: 5,
      directEvidenceCount: 0,
      profileEvidenceCount: 0
    });

    const topic = await inspectV2Topic(storage, "Albert Einstein", { question: "Who was Albert Einstein?" });
    expect(topic.learnedGraphPriorCount).toBeGreaterThan(0);
    expect(topic.answerGradeEdgeCount).toBeGreaterThan(0);
    expect(topic.questionCognitiveEdgeCount).toBeGreaterThan(0);
    expect(topic.questionSelectedEdgeCount).toBeGreaterThan(0);
    expect([QUESTION_EDGE_DECISION_IDS.requestedSupport, QUESTION_EDGE_DECISION_IDS.partialSupport]).toContain(topic.questionDecisionPreview);
    expect(topic.topQuestionFits[0]?.subject).toBe("Albert Einstein");
    expect(topic.weakFragmentEdgeCount).toBe(0);
    expect(topic.directEvidenceCount).toBe(0);
    expect(topic.languagePriorCount).toBe(5);
    expect(topic.relevanceGateDecisionPreview).toBe(QUESTION_EDGE_DECISION_IDS.requestedSupport);
    expect(topic.topAnswerGradeRelations[0]?.quality?.answerGrade).toBe(true);

    const languageOnly = await inspectV2Topic(fakePostgresStorage({ nodes: [], edges: [], languageCount: 4, directEvidenceCount: 0, profileEvidenceCount: 0 }), "Star Trek");
    expect(languageOnly.relevanceGateDecisionPreview).toBe(QUESTION_EDGE_DECISION_IDS.languageOnlyRejected);
    expect(languageOnly.directEvidenceCount).toBe(0);
  });

  it("reports question-shaped fit separately from raw topic edge quality", async () => {
    const topic = await inspectV2Topic(fakePostgresStorage({
      nodes: [
        { id: "node.star-trek", representation_json: { label: "Star Trek" }, alpha: 0.8, metadata_json: { forceClass: "learned_concept_prior" } }
      ],
      edges: [
        {
          id: "edge.star-trek.theme",
          relation_id: "relation.work.theme_music_composer",
          weight: 0.93,
          alpha: 0.7,
          metadata_json: { relation: { subject: "Star Trek: The Original Series", predicate: "theme_music_composer", object: "Alexander Courage" }, forceClass: "learned_concept_prior" }
        },
        {
          id: "edge.star-trek.voyager.character",
          relation_id: "relation.work.character",
          weight: 0.82,
          alpha: 0.68,
          metadata_json: { relation: { subject: "Star Trek: Voyager", predicate: "character", object: "Tom Paris" }, forceClass: "learned_concept_prior" }
        }
      ],
      languageCount: 0,
      directEvidenceCount: 0,
      profileEvidenceCount: 0
    }), "Star Trek", { question: "Who are the main characters in Star Trek?" });

    expect(topic.answerGradeEdgeCount).toBeGreaterThanOrEqual(1);
    expect(topic.questionCognitiveEdgeCount).toBeGreaterThanOrEqual(2);
    expect(topic.questionSelectedEdgeCount).toBeGreaterThan(0);
    expect(topic.topQuestionFits.some(row => row.object === "Tom Paris")).toBe(true);
    expect(topic.topQuestionFits.some(row => row.object === "Alexander Courage")).toBe(false);
    expect(topic.questionRejectedFits.some(row => row.object === "Alexander Courage")).toBe(true);
  });

  it("separates answer-grade topic relations from dirty Einstein-style fragments", async () => {
    const topic = await inspectV2Topic(fakePostgresStorage({
      nodes: [
        { id: "node.einstein", representation_json: { label: "Albert Einstein" }, alpha: 0.7, metadata_json: { forceClass: "learned_concept_prior" } }
      ],
      edges: [
        {
          id: "edge.clean.field",
          relation_id: "relation.person.field",
          weight: 0.92,
          alpha: 0.7,
          metadata_json: { relation: { subject: "Albert Einstein", predicate: "field", object: "physics" }, forceClass: "learned_concept_prior" }
        },
        {
          id: "edge.dirty.according",
          relation_id: "relation.fragment",
          weight: 1,
          alpha: 0.6,
          metadata_json: { relation: { subject: "according", predicate: "to", object: "Albert Einstein's theory of relativity" }, forceClass: "learned_concept_prior" }
        },
        {
          id: "edge.category.medal",
          relation_id: "relation.category",
          weight: 1,
          alpha: 0.6,
          metadata_json: { relation: { subject: "Murray Gell-Mann", predicate: "in-category", object: "Albert Einstein medal recipients" }, forceClass: "learned_concept_prior" }
        },
        {
          id: "edge.noisy.markup",
          relation_id: "relation.fragment",
          weight: 1,
          alpha: 0.6,
          metadata_json: { relation: { subject: "{{Infobox scientist", predicate: "the", object: "[[Albert Einstein]] {{citation needed}}" }, forceClass: "learned_concept_prior" }
        }
      ],
      languageCount: 0,
      directEvidenceCount: 0,
      profileEvidenceCount: 0
    }), "Albert Einstein");

    expect(topic.answerGradeEdgeCount).toBe(1);
    expect(topic.weakFragmentEdgeCount).toBeGreaterThanOrEqual(1);
    expect(topic.categoryEdgeCount).toBe(1);
    expect(topic.noisyEdgeCount).toBeGreaterThanOrEqual(1);
    expect(topic.topAnswerGradeRelations.map(row => row.predicate)).toContain("field");
    expect(topic.topAnswerGradeRelations.map(row => row.predicate)).not.toContain("to");
    expect(topic.topRejectedRelations.some(row => row.reasonIds.includes(GRAPH_QUALITY_REASON_IDS.functionPredicate))).toBe(true);
    expect(topic.relevanceGateDecisionPreview).toBe(QUESTION_EDGE_DECISION_IDS.requestedSupport);
  });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fakePostgresStorage(input: {
  nodes: Array<{ id: string; representation_json: unknown; alpha: number; metadata_json: unknown }>;
  edges: Array<{ id?: string; relation_id: string; weight: number; alpha: number; metadata_json: unknown }>;
  languageCount: number;
  directEvidenceCount: number;
  profileEvidenceCount: number;
}): ScceStorage {
  return {
    table(name: string) {
      return name;
    },
    async query<T>(sql: string): Promise<T[]> {
      if (sql.includes("FROM graph_nodes")) return input.nodes as T[];
      if (sql.includes("FROM graph_edges")) return input.edges.map((edge, index) => ({ id: edge.id ?? `edge.${index}`, ...edge })) as T[];
      if (sql.includes("FROM evidence_spans") && sql.includes("direct_evidence")) return [{ count: String(input.directEvidenceCount) }] as T[];
      if (sql.includes("FROM evidence_spans") && sql.includes("profile_excerpt_evidence")) return [{ count: String(input.profileEvidenceCount) }] as T[];
      if (sql.includes("FROM evidence_spans")) return [{ count: String(input.directEvidenceCount + input.profileEvidenceCount) }] as T[];
      if (sql.includes("FROM language_units")) return [{ count: String(input.languageCount) }] as T[];
      return [];
    }
  } as unknown as ScceStorage;
}
