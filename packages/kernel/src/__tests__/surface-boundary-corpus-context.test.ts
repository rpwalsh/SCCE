// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { measureSurfaceBoundaries, collectBoundaryTrainingObservations, compileBoundaryFeatureContext } from "../surface-lattice.js";

it("replays exact corpus observations one owned document at a time using the same context arithmetic", () => {
  const lattices = ["opaque alpha delta. opaque beta delta.", "opaque alpha delta. opaque gamma delta."].map((text, index) =>
    measureSurfaceBoundaries({ documentId: `owned.${index}`, text }));
  const context = compileBoundaryFeatureContext({ lattices });
  const expected = collectBoundaryTrainingObservations({ lattices });
  let corpusDiffersFromLocal = false;
  for (const lattice of lattices) {
    const actual = collectBoundaryTrainingObservations({ lattices: [lattice], featureContext: context });
    expect(actual).toEqual(expected.filter(row => row.sourceDocumentId === lattice.documentId));
    corpusDiffersFromLocal ||= JSON.stringify(actual) !== JSON.stringify(collectBoundaryTrainingObservations({ lattices: [lattice] }));
  }
  expect(corpusDiffersFromLocal).toBe(true);
});

it("refuses an incomplete or malformed explicitly supplied corpus context", () => {
  const lattice = measureSurfaceBoundaries({ documentId: "owned", text: "opaque alpha delta. opaque beta delta." });
  const context = compileBoundaryFeatureContext({ lattices: [lattice] });
  const zero = { ...context, documentCountBySurfaceFormClass: Object.fromEntries(Object.keys(context.documentCountBySurfaceFormClass).map(key=>[key,0])),
    classCountByBoundaryContext: Object.fromEntries(Object.keys(context.classCountByBoundaryContext).map(key=>[key,0])) };
  expect(collectBoundaryTrainingObservations({ lattices:[lattice],featureContext:zero }).some(row=>row.signalKind==="exact_repeated_phrase")).toBe(false);
  expect(() => collectBoundaryTrainingObservations({ lattices: [lattice], featureContext: { ...context, documentCountBySurfaceFormClass: {} } })).toThrow(/Incomplete/);
  expect(() => collectBoundaryTrainingObservations({ lattices: [lattice], featureContext: { ...context, classCountByBoundaryContext: {} } })).toThrow(/Incomplete/);
  expect(() => collectBoundaryTrainingObservations({ lattices: [lattice], featureContext: { ...context, sourceDocumentCount: 0 } })).toThrow(/header/);
});
