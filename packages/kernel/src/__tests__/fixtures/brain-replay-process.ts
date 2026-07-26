import { compileBrainReplayManifest } from "../../brain-lifecycle.js";

const componentIds = process.argv.slice(2);
const replay = compileBrainReplayManifest({
  sourceSchema: "fixture.brain.v1",
  sourceManifestHash: "a".repeat(64),
  componentIds,
  content: {
    graphShardCount: 2,
    languageShardCount: 1,
    ngramStateCount: 1,
    priorSectionCount: 1
  },
  configuration: { deterministic: true }
});
process.stdout.write(JSON.stringify({
  id: replay.id,
  byteHash: replay.byteHash,
  canonicalBytes: replay.canonicalBytes
}));
