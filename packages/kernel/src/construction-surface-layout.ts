// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { composeConstructionSurface, type ConstructionSurface, type ConstructionSurfacePiece } from "./construction-surface.js";
import { renderDocumentParagraphs } from "./document-plan.js";

/** Paragraph separators belong to document layout; every block retains its complete construction derivation. */
export function layoutConstructionParagraphs(blocks: readonly { nodeId: string; surface: ConstructionSurface }[]): ConstructionSurface | undefined {
  const pieces: ConstructionSurfacePiece[] = [];
  blocks.forEach((block, index) => {
    if (index) pieces.push({ kind: "literal", surface: renderDocumentParagraphs(["", ""]), evidenceIds: [], sourceExampleIds: [] });
    pieces.push({ kind: "slot", roleId: block.nodeId, surface: block.surface });
  });
  return composeConstructionSurface(pieces);
}
