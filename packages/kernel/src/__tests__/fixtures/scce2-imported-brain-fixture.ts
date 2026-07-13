export const scce2ImportedBrainFixture = {
  importRunId: "import-fixture",
  activeBrainVersion: "scce2:fixture",
  language: {
    streamId: "stream:fixture",
    profileId: "profile:fixture",
    languageHint: "learned:scce2",
    script: "fixture-script",
    phrase: {
      id: "unit:azurite",
      text: "azurite",
      count: 6,
      alpha: 0.9
    },
    ngramModel: {
      id: "model:azurite",
      symbolCount: 8,
      vocabulary: ["azurite", "operator"]
    },
    ngramObservation: {
      id: "obs:azurite",
      symbol: "azurite",
      count: 6
    },
    pattern: {
      id: "pattern:azurite",
      support: 0.8
    }
  },
  graph: {
    concept: "azurite",
    neighbor: "cyan",
    relation: "stabilizes",
    statement: "azurite operator stabilizes the cyan surface",
    sourceVersionIdSeed: "graph-prior",
    nodeAlpha: 0.91,
    edgeAlpha: 0.84
  },
  directEvidence: {
    sourceUri: "https://fixture.invalid/azurite-source",
    sourceVersionId: "fixture-source-version:azurite:1",
    byteRange: [14, 61] as [number, number],
    charRange: [14, 61] as [number, number],
    text: "azurite operator stabilizes the cyan surface"
  },
  profileExcerptEvidence: {
    title: "SCCE2 profile excerpt without original source coordinates",
    text: "azurite operator stabilizes the cyan surface"
  },
  priorOnly: {
    forceClass: "learned_language_prior",
    text: "azurite operator stabilizes the cyan surface"
  }
} as const;
