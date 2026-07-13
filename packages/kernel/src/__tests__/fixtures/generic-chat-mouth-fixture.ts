export const genericChatMouthFixture = {
  claim: "Greenhouse vents open before noon above 70% humidity.",
  evidenceText: "The greenhouse opens its vents before noon when humidity rises above 70%.",
  importedSemanticFrame: "humid-morning vent rule opens greenhouse vents before noon above 70% humidity.",
  importedPhrase: "humid-morning vent rule",
  discourseBoundary: ":",
  caveatText: "sensor calibration is not independently confirmed",
  correction: {
    observedSurface: "humid-morning",
    preferredSurface: "morning-humidity"
  },
  creativeArtifact: {
    path: "garden-note.txt",
    mediaType: "text/plain",
    content: "Morning air lifts the glasshouse awake."
  }
} as const;
