export const genericChatQualityFixture = {
  claim: "Library lights dim to 40% after 9:00 p.m. to reduce glare.",
  evidenceText: "The library lighting policy dims reading-room lights to 40% after 9:00 p.m. so late patrons have less screen glare.",
  importedSemanticFrame: "quiet-hours lighting cue dims library lights to 40% after 9:00 p.m. for lower glare.",
  importedPhrase: "quiet-hours lighting cue",
  discourseBoundary: ":",
  caveatText: "holiday schedule exceptions were not checked",
  correction: {
    observedSurface: "quiet-hours",
    preferredSurface: "evening-reading"
  },
  creativeArtifact: {
    path: "reading-room-note.txt",
    mediaType: "text/plain",
    content: "A soft lamp line marks the late room."
  }
} as const;
