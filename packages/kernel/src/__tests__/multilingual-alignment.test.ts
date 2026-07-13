import { describe, expect, it } from "vitest";
import { createAlignmentEngine, createCorrectionEngine } from "../index.js";
import { decayCorrectionAlpha, detectConflictingCorrections } from "../translation-correction-engine.js";

describe("multilingual alignment", () => {
  it("trains lexical alignment from parallel sentences", () => {
    const engine = createAlignmentEngine();

    const corpus = {
      sourceLanguage: "eng",
      targetLanguage: "spa",
      sentencePairs: [
        { sourceText: "hello world", targetText: "hola mundo" },
        { sourceText: "good morning", targetText: "buenos días" },
        { sourceText: "hello friend", targetText: "hola amigo" }
      ],
      corpusType: "parallel_sentences" as const,
      evidenceIds: []
    };

    const model = engine.trainLexicalAlignment(corpus);

    expect(model.sourceLanguage).toBe("eng");
    expect(model.targetLanguage).toBe("spa");
    expect(model.alignmentCounts.totalPairs).toBeGreaterThan(0);
    expect(model.alignmentCounts.uniqueSourceTerms).toBeGreaterThan(0);
    expect(model.alignmentCounts.uniqueTargetTerms).toBeGreaterThan(0);
    expect(model.lexicalTable["hello"]).toBeDefined();
    const helloTargets = model.lexicalTable["hello"];
    expect(helloTargets).toBeDefined();
    expect((helloTargets?.["hola"] ?? 0)).toBeGreaterThan(0);
  });

  it("trains phrase alignment from parallel sentences", () => {
    const engine = createAlignmentEngine();

    const corpus = {
      sourceLanguage: "eng",
      targetLanguage: "fra",
      sentencePairs: [
        { sourceText: "how are you", targetText: "comment allez vous" },
        { sourceText: "how are you today", targetText: "comment allez vous aujourd hui" }
      ],
      corpusType: "parallel_sentences" as const,
      evidenceIds: []
    };

    const lexicalModel = engine.trainLexicalAlignment(corpus);
    const phraseModel = engine.trainPhraseAlignment(corpus, lexicalModel);

    expect(phraseModel.sourceLanguage).toBe("eng");
    expect(phraseModel.targetLanguage).toBe("fra");
    expect(phraseModel.phraseTable.length).toBeGreaterThan(0);
    expect(phraseModel.topPhraseCoverage).toBeGreaterThan(0);
  });

  it("scores alignment between source and target text", () => {
    const engine = createAlignmentEngine();

    const corpus = {
      sourceLanguage: "eng",
      targetLanguage: "deu",
      sentencePairs: [
        { sourceText: "the cat sat", targetText: "die katze saß" },
        { sourceText: "the cat runs", targetText: "die katze läuft" }
      ],
      corpusType: "parallel_sentences" as const,
      evidenceIds: []
    };

    const lexicalModel = engine.trainLexicalAlignment(corpus);
    const phraseModel = engine.trainPhraseAlignment(corpus, lexicalModel);

    const score = engine.scoreAlignment({
      sourceText: "the cat",
      targetText: "die katze",
      lexicalModel,
      phraseModel,
      preservedEntities: []
    });

    expect(score.finalScore).toBeGreaterThan(0.3);
    expect(score.lexicalScore).toBeGreaterThan(0);
    expect(score.lexicalScore).toBeLessThanOrEqual(1);
  });

  it("preserves numbers and entities in translation scoring", () => {
    const engine = createAlignmentEngine();

    const lexicalModel = {
      id: "lex1",
      sourceLanguage: "eng",
      targetLanguage: "ita",
      alignmentVersion: 1,
      lexicalTable: { "room": { "stanza": 0.9 }, "123": { "123": 1.0 } },
      reverseTable: { "stanza": { "room": 0.9 }, "123": { "123": 1.0 } },
      alignmentCounts: { totalPairs: 2, uniqueSourceTerms: 2, uniqueTargetTerms: 2 },
      perplexity: 2,
      trainingCorpora: [],
      updatedAt: Date.now()
    };

    const phraseModel = {
      id: "phr1",
      sourceLanguage: "eng",
      targetLanguage: "ita",
      alignmentVersion: 1,
      phraseTable: [],
      topPhraseCoverage: 0.5,
      trainingCorpora: [],
      updatedAt: Date.now()
    };

    const score = engine.scoreAlignment({
      sourceText: "room 123",
      targetText: "stanza 123",
      lexicalModel,
      phraseModel,
      preservedEntities: ["room", "stanza"]
    });

    expect(score.anchorScore).toBeGreaterThan(0.5);
    expect(score.finalScore).toBeGreaterThan(0.4);
  });

  it("extracts alignment observations from corpus", () => {
    const engine = createAlignmentEngine();

    const corpus = {
      sourceLanguage: "eng",
      targetLanguage: "jpn",
      sentencePairs: [
        { sourceText: "water", targetText: "水" },
        { sourceText: "water", targetText: "水" }
      ],
      corpusType: "parallel_sentences" as const,
      evidenceIds: []
    };

    const observations = engine.extractAlignmentObservations(corpus);

    expect(observations.length).toBeGreaterThan(0);
    if (observations.length > 0) {
      const first = observations[0];
      expect(first).toBeDefined();
      if (first) {
        expect(first.sourceLanguage).toBe("eng");
        expect(first.targetLanguage).toBe("jpn");
        expect(first.cooccurrenceCount).toBeGreaterThan(0);
      }
    }
  });

  it("learns from user corrections with high alpha", () => {
    const engine = createAlignmentEngine();

    const corpus = {
      sourceLanguage: "eng",
      targetLanguage: "por",
      sentencePairs: [],
      userCorrections: [
        {
          id: "ucor1",
          sourceLanguage: "eng",
          targetLanguage: "por",
          sourceText: "good morning",
          previousOutput: "bueno mañana",
          correctedOutput: "bom dia",
          sourceProfileId: "prof1",
          targetProfileId: "prof2",
          protectedTerms: [],
          changedTerms: [
            { original: "bueno", corrected: "bom", reason: "better greeting" },
            { original: "mañana", corrected: "dia", reason: "better form" }
          ],
          alignmentDelta: {},
          alpha: 0.95,
          episodeId: "ep1" as any,
          evidenceIds: [],
          createdAt: Date.now()
        }
      ],
      corpusType: "user_corrections" as const,
      evidenceIds: []
    };

    const model = engine.trainLexicalAlignment(corpus);

    expect(model.lexicalTable["bueno"]).toBeDefined();
    if (model.lexicalTable["bueno"]) {
      expect(model.lexicalTable["bueno"]["bom"]).toBeGreaterThan(0);
    }
  });

  it("does not hallucinate content not in source", () => {
    const engine = createAlignmentEngine();

    const lexicalModel = {
      id: "lex1",
      sourceLanguage: "eng",
      targetLanguage: "rus",
      alignmentVersion: 1,
      lexicalTable: {},
      reverseTable: {},
      alignmentCounts: { totalPairs: 0, uniqueSourceTerms: 0, uniqueTargetTerms: 0 },
      perplexity: 0,
      trainingCorpora: [],
      updatedAt: Date.now()
    };

    const phraseModel = {
      id: "phr1",
      sourceLanguage: "eng",
      targetLanguage: "rus",
      alignmentVersion: 1,
      phraseTable: [],
      topPhraseCoverage: 0,
      trainingCorpora: [],
      updatedAt: Date.now()
    };

    const score = engine.scoreAlignment({
      sourceText: "cat",
      targetText: "кот полностью не связанный с источником",
      lexicalModel,
      phraseModel,
      protectedTerms: ["cat"]
    });

    expect(score.hallucinationPenalty).toBeGreaterThan(0.2);
    expect(score.finalScore).toBeLessThan(0.6);
  });

  it("handles mixed script languages correctly", () => {
    const engine = createAlignmentEngine();

    const corpus = {
      sourceLanguage: "eng",
      targetLanguage: "kok",
      sentencePairs: [
        { sourceText: "hello", targetText: "안녕하세요" },
        { sourceText: "hi", targetText: "안녕" }
      ],
      corpusType: "parallel_sentences" as const,
      evidenceIds: []
    };

    const model = engine.trainLexicalAlignment(corpus);

    expect(model.alignmentCounts.uniqueSourceTerms).toBeGreaterThan(0);
    expect(model.alignmentCounts.uniqueTargetTerms).toBeGreaterThan(0);
  });
});

describe("translation correction engine", () => {
  it("records user feedback as correction alignment", () => {
    const engine = createCorrectionEngine();

    const feedback = {
      episodeId: "ep1" as any,
      sourceLanguage: "eng",
      targetLanguage: "ita",
      sourceText: "the quick brown fox",
      generatedTranslation: "la rápida zorro marrón",
      correctedTranslation: "la veloce volpe marrone",
      protectedTerms: ["fox", "brown"],
      changedTerms: [
        { original: "rápida", corrected: "veloce", reason: "more accurate adjective" },
        { original: "zorro", corrected: "volpe", reason: "better noun" },
        { original: "marrón", corrected: "marrone", reason: "correct form" }
      ],
      sourceProfileId: "prof1",
      targetProfileId: "prof2",
      evidenceIds: []
    };

    const record = engine.recordFeedback(feedback);

    expect(record.sourceLanguage).toBe("eng");
    expect(record.targetLanguage).toBe("ita");
    expect(record.alpha).toBeGreaterThan(0.5);
    expect(record.changedTerms.length).toBe(3);
  });

  it("computes higher alpha for small, targeted corrections", () => {
    const engine = createCorrectionEngine();

    const minorFeedback = {
      episodeId: "ep1" as any,
      sourceLanguage: "eng",
      targetLanguage: "ara",
      sourceText: "hello world",
      generatedTranslation: "مرحبا العالم",
      correctedTranslation: "مرحبا بالعالم",
      protectedTerms: [],
      changedTerms: [{ original: "العالم", corrected: "بالعالم", reason: "better preposition" }],
      sourceProfileId: "prof1",
      targetProfileId: "prof2",
      evidenceIds: []
    };

    const minorRecord = engine.recordFeedback(minorFeedback);

    const majorFeedback = {
      episodeId: "ep2" as any,
      sourceLanguage: "eng",
      targetLanguage: "ara",
      sourceText: "the quick brown fox jumps",
      generatedTranslation: "bad translation",
      correctedTranslation: "الثعلب البني السريع يقفز بسرعة",
      protectedTerms: [],
      changedTerms: [
        { original: "bad", corrected: "الثعلب", reason: "" },
        { original: "translation", corrected: "البني", reason: "" },
        { original: "", corrected: "السريع", reason: "" },
        { original: "", corrected: "يقفز", reason: "" },
        { original: "", corrected: "بسرعة", reason: "" }
      ],
      sourceProfileId: "prof1",
      targetProfileId: "prof2",
      evidenceIds: []
    };

    const majorRecord = engine.recordFeedback(majorFeedback);

    expect(minorRecord.alpha).toBeGreaterThan(majorRecord.alpha);
  });

  it("validates roundtrip translation", () => {
    const engine = createCorrectionEngine();

    const validation = engine.validateRoundTrip({
      originalLanguage: "eng",
      sourceLanguage: "eng",
      targetLanguage: "fra",
      originalText: "the cat is sleeping",
      sourceTranslation: "the cat is sleeping",
      targetTranslation: "le chat dort",
      backTranslation: "the cat sleeps",
      preservedEntities: ["cat"],
      preservedNumbers: [],
      evidenceIds: []
    });

    expect(validation.entityPreservation).toBeGreaterThan(0.8);
    expect(validation.semanticSimilarity).toBeGreaterThan(0.5);
    expect(typeof validation.passed).toBe("boolean");
  });

  it("detects semantic drift in roundtrip", () => {
    const engine = createCorrectionEngine();

    const validation = engine.validateRoundTrip({
      originalLanguage: "eng",
      sourceLanguage: "eng",
      targetLanguage: "hin",
      originalText: "I like coffee",
      sourceTranslation: "मुझे कॉफी पसंद है",
      targetTranslation: "मुझे चाय पसंद है",
      backTranslation: "I like tea",
      preservedEntities: [],
      preservedNumbers: [],
      evidenceIds: []
    });

    expect(validation.semanticSimilarity).toBeLessThan(0.9);
    expect(validation.issues.length).toBeGreaterThan(0);
  });

  it("preserves entity anchors across roundtrip", () => {
    const engine = createCorrectionEngine();

    const validation = engine.validateRoundTrip({
      originalLanguage: "eng",
      sourceLanguage: "eng",
      targetLanguage: "deu",
      originalText: "Berlin is capital",
      sourceTranslation: "Berlin ist die Hauptstadt",
      targetTranslation: "Berlín es la capital",
      backTranslation: "Berlin is the capital",
      preservedEntities: ["Berlin"],
      preservedNumbers: [],
      evidenceIds: []
    });

    expect(validation.entityPreservation).toBe(1.0);
  });

  it("detects number corruption in translation", () => {
    const engine = createCorrectionEngine();

    const validation = engine.validateRoundTrip({
      originalLanguage: "eng",
      sourceLanguage: "eng",
      targetLanguage: "zho",
      originalText: "There are 42 books",
      sourceTranslation: "有42本书",
      targetTranslation: "有100本书",
      backTranslation: "There are 100 books",
      preservedEntities: ["books"],
      preservedNumbers: ["42"],
      evidenceIds: []
    });

    expect(validation.numberPreservation).toBeLessThan(1.0);
    expect(validation.issues).toContain("number_corruption");
  });

  it("computes competence feedback from corrections", () => {
    const engine = createCorrectionEngine();

    const corrections = [
      {
        id: "c1",
        sourceLanguage: "eng",
        targetLanguage: "ita",
        sourceText: "hello",
        previousOutput: "ciao",
        correctedOutput: "salve",
        sourceProfileId: "prof_eng",
        targetProfileId: "prof_ita",
        protectedTerms: [],
        changedTerms: [{ original: "ciao", corrected: "salve", reason: "" }],
        alignmentDelta: {},
        alpha: 0.9,
        episodeId: "ep1" as any,
        evidenceIds: [],
        createdAt: Date.now()
      },
      {
        id: "c2",
        sourceLanguage: "eng",
        targetLanguage: "ita",
        sourceText: "goodbye",
        previousOutput: "addio",
        correctedOutput: "arrivederci",
        sourceProfileId: "prof_eng",
        targetProfileId: "prof_ita",
        protectedTerms: [],
        changedTerms: [{ original: "addio", corrected: "arrivederci", reason: "" }],
        alignmentDelta: {},
        alpha: 0.85,
        episodeId: "ep2" as any,
        evidenceIds: [],
        createdAt: Date.now()
      }
    ];

    const alignments: any[] = [];
    const feedback = engine.computeCompetenceFeedback(corrections, alignments);

    expect(feedback.length).toBeGreaterThan(0);
    if (feedback.length > 0) {
      const first = feedback[0];
      expect(first).toBeDefined();
      if (first) {
        expect(first.sourceProfileId).toBe("prof_eng");
        expect(first.correctionCount).toBe(2);
        expect(first.averageAlpha).toBeGreaterThan(0.8);
      }
    }
  });

  it("decays correction alpha based on age relative to half-life", () => {
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const fresh = { alpha: 0.9, createdAt: now };
    expect(decayCorrectionAlpha(fresh, now)).toBeCloseTo(0.9, 4);

    const oneHalfLife = { alpha: 0.9, createdAt: now - oneWeekMs };
    expect(decayCorrectionAlpha(oneHalfLife, now)).toBeCloseTo(0.45, 2);

    const twoHalfLives = { alpha: 0.9, createdAt: now - 2 * oneWeekMs };
    expect(decayCorrectionAlpha(twoHalfLives, now)).toBeCloseTo(0.225, 2);
  });

  it("detects conflicting corrections for the same source term", () => {
    const corrections = [
      {
        id: "c1",
        changedTerms: [{ original: "hello", corrected: "ciao", reason: "" }]
      },
      {
        id: "c2",
        changedTerms: [{ original: "hello", corrected: "salve", reason: "" }]
      },
      {
        id: "c3",
        changedTerms: [{ original: "goodbye", corrected: "arrivederci", reason: "" }]
      }
    ];

    const conflicts = detectConflictingCorrections(corrections);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.term).toBe("hello");
    expect(conflicts[0]?.targetA).toBe("ciao");
    expect(conflicts[0]?.targetB).toBe("salve");
  });

  it("lowers alpha for suspicious all-token-replacement corrections", () => {
    const engine = createCorrectionEngine();
    const feedback = {
      episodeId: "ep-suspicious" as any,
      sourceLanguage: "eng",
      targetLanguage: "xyz",
      sourceText: "hello world friend",
      generatedTranslation: "hello world friend",
      correctedTranslation: "randomword1 randomword2 randomword3",
      protectedTerms: [],
      changedTerms: [
        { original: "hello", corrected: "totallydifferentterm_aaaaaaaa", reason: "suspected junk" },
        { original: "world", corrected: "anothertotallydifferentthing", reason: "suspected junk" }
      ],
      sourceProfileId: "prof-a",
      targetProfileId: "prof-b",
      evidenceIds: []
    };

    const normal = engine.recordFeedback({ ...feedback, changedTerms: [{ original: "hello", corrected: "hola", reason: "spanish" }] });
    const suspicious = engine.recordFeedback(feedback);
    expect(suspicious.alpha).toBeLessThan(normal.alpha);
  });
});
