import { describe, expect, it } from "vitest";
import {
  EMPTY_DOCUMENT_PLAN,
  addDocumentPlanNode,
  type DocumentPlan
} from "../document-plan.js";
import {
  applyDocumentRevisionPatch,
  deleteDocumentPlanNode,
  diffDocumentPlans,
  documentPlanSectionNumbers,
  insertDocumentPlanNode,
  invertDocumentRevisionPatch,
  mergeDocumentPlanNodes,
  moveDocumentPlanNode,
  rewriteDocumentPlanNodeContent,
  splitDocumentPlanNode
} from "../document-revision.js";

function threeSectionPlan(): DocumentPlan {
  let plan = addDocumentPlanNode(EMPTY_DOCUMENT_PLAN, { id: "doc", kind: "document", order: 0, goal: "root" });
  plan = addDocumentPlanNode(plan, { id: "doc.intro", kind: "section", parentId: "doc", order: 0, goal: "intro" });
  plan = addDocumentPlanNode(plan, { id: "doc.body", kind: "section", parentId: "doc", order: 1, goal: "body" });
  plan = addDocumentPlanNode(plan, { id: "doc.conclusion", kind: "section", parentId: "doc", order: 2, goal: "conclusion" });
  return plan;
}

describe("document revision patches are exactly reversible (plan items 227-228)", () => {
  it("rewrite produces a patch whose inverse restores the exact original plan", () => {
    const before = threeSectionPlan();
    const { plan: after, patch } = rewriteDocumentPlanNodeContent(before, "doc.body", "The body text.");
    expect(after.nodes["doc.body"]!.content).toBe("The body text.");

    const restored = applyDocumentRevisionPatch(after, invertDocumentRevisionPatch(patch));
    expect(restored).toEqual(before);
  });

  it("an unaffected section preserves identity (byte-for-byte) across an unrelated revision", () => {
    const before = threeSectionPlan();
    const introBefore = before.nodes["doc.intro"];
    const conclusionBefore = before.nodes["doc.conclusion"];

    const { plan: after } = rewriteDocumentPlanNodeContent(before, "doc.body", "Revised body content.");

    expect(after.nodes["doc.intro"]).toEqual(introBefore);
    expect(after.nodes["doc.conclusion"]).toEqual(conclusionBefore);
    // Not just equal in value -- the diff mechanism itself must report
    // them as unchanged, not merely "changed to the same value".
    const patch = diffDocumentPlans(before, after);
    expect(patch.changed.map(change => change.after.id)).toEqual(["doc.body"]);
    expect(patch.removed).toEqual([]);
    expect(patch.added).toEqual([]);
  });

  it("insert, move, and delete each produce a patch that round-trips exactly", () => {
    const before = threeSectionPlan();

    const inserted = insertDocumentPlanNode(before, {
      id: "doc.appendix",
      kind: "section",
      parentId: "doc",
      order: 3,
      goal: "appendix"
    });
    expect(applyDocumentRevisionPatch(inserted.plan, invertDocumentRevisionPatch(inserted.patch))).toEqual(before);

    const moved = moveDocumentPlanNode(inserted.plan, "doc.appendix", { parentId: "doc", order: 1 });
    expect(applyDocumentRevisionPatch(moved.plan, invertDocumentRevisionPatch(moved.patch))).toEqual(inserted.plan);

    const deleted = deleteDocumentPlanNode(moved.plan, "doc.appendix");
    expect(applyDocumentRevisionPatch(deleted.plan, invertDocumentRevisionPatch(deleted.patch))).toEqual(moved.plan);
  });

  it("refuses to delete a node that still has children", () => {
    const plan = threeSectionPlan();
    expect(() => deleteDocumentPlanNode(plan, "doc")).toThrow(/still has children/);
  });

  it("refuses to delete a node still cited or rhetorically depended on by another node -- maintaining argument dependencies means rejecting the orphaning deletion, not performing it", () => {
    let plan = threeSectionPlan();
    plan = addDocumentPlanNode(plan, {
      id: "doc.appendix",
      kind: "section",
      parentId: "doc",
      order: 3,
      goal: "appendix",
      rhetoricalDependsOnIds: ["doc.body"]
    });
    expect(() => deleteDocumentPlanNode(plan, "doc.body")).toThrow(/still referenced or rhetorically depended on/);
  });

  it("merge combines sibling nodes into one, carrying over their coverage and references, with a fully reversible patch", () => {
    let plan = threeSectionPlan();
    plan = { nodes: { ...plan.nodes, "doc.intro": { ...plan.nodes["doc.intro"]!, requiredCoverageIds: ["hello"] } } };
    plan = { nodes: { ...plan.nodes, "doc.body": { ...plan.nodes["doc.body"]!, requiredCoverageIds: ["main-point"] } } };

    const { plan: merged, patch } = mergeDocumentPlanNodes(plan, {
      sourceNodeIds: ["doc.intro", "doc.body"],
      mergedNodeId: "doc.intro-body",
      mergedContent: "Combined intro and body.",
      mergedGoal: "intro + body combined"
    });

    expect(merged.nodes["doc.intro"]).toBeUndefined();
    expect(merged.nodes["doc.body"]).toBeUndefined();
    expect(merged.nodes["doc.intro-body"]!.requiredCoverageIds.sort()).toEqual(["hello", "main-point"]);

    const restored = applyDocumentRevisionPatch(merged, invertDocumentRevisionPatch(patch));
    expect(restored).toEqual(plan);
  });

  it("split is the reverse shape of merge -- one node's content distributed into new nodes, with a fully reversible patch", () => {
    let plan = threeSectionPlan();
    plan = { nodes: { ...plan.nodes, "doc.body": { ...plan.nodes["doc.body"]!, content: "Part one. Part two." } } };

    const { plan: split, patch } = splitDocumentPlanNode(plan, {
      sourceNodeId: "doc.body",
      intoNodes: [
        { id: "doc.body.part1", kind: "subsection", parentId: "doc", order: 1, goal: "part one", content: "Part one." },
        { id: "doc.body.part2", kind: "subsection", parentId: "doc", order: 2, goal: "part two", content: "Part two." }
      ]
    });

    expect(split.nodes["doc.body"]).toBeUndefined();
    expect(split.nodes["doc.body.part1"]!.content).toBe("Part one.");
    expect(split.nodes["doc.body.part2"]!.content).toBe("Part two.");

    const restored = applyDocumentRevisionPatch(split, invertDocumentRevisionPatch(patch));
    expect(restored).toEqual(plan);
  });

  it("refuses to merge or split a node still referenced by another node", () => {
    let plan = threeSectionPlan();
    plan = addDocumentPlanNode(plan, {
      id: "doc.appendix",
      kind: "section",
      parentId: "doc",
      order: 3,
      goal: "appendix",
      referenceIds: ["doc.body"]
    });
    expect(() => mergeDocumentPlanNodes(plan, {
      sourceNodeIds: ["doc.intro", "doc.body"],
      mergedNodeId: "doc.merged",
      mergedContent: "x",
      mergedGoal: "x"
    })).toThrow(/still referenced/);
    expect(() => splitDocumentPlanNode(plan, {
      sourceNodeId: "doc.body",
      intoNodes: [
        { id: "a", kind: "subsection", parentId: "doc", order: 1, goal: "a" },
        { id: "b", kind: "subsection", parentId: "doc", order: 2, goal: "b" }
      ]
    })).toThrow(/still referenced/);
  });
});

describe("document section numbering is always derived fresh, never stale (plan item 227)", () => {
  it("renumbers correctly after a deletion, with no leftover gap", () => {
    const plan = threeSectionPlan();
    // Number doc's *children* as sections 1/2/3 -- the document root
    // itself is not "section 1", its children are.
    const before = documentPlanSectionNumbers(plan, "doc");
    expect(before.get("doc.intro")).toBe("1");
    expect(before.get("doc.body")).toBe("2");
    expect(before.get("doc.conclusion")).toBe("3");

    const { plan: afterDelete } = deleteDocumentPlanNode(plan, "doc.body");
    const after = documentPlanSectionNumbers(afterDelete, "doc");
    expect(after.get("doc.intro")).toBe("1");
    expect(after.get("doc.conclusion")).toBe("2");
    expect([...after.values()]).not.toContain("3");
  });

  it("numbers nested subsections hierarchically", () => {
    let plan = threeSectionPlan();
    plan = addDocumentPlanNode(plan, { id: "doc.body.sub1", kind: "subsection", parentId: "doc.body", order: 0, goal: "sub1" });
    plan = addDocumentPlanNode(plan, { id: "doc.body.sub2", kind: "subsection", parentId: "doc.body", order: 1, goal: "sub2" });
    const numbers = documentPlanSectionNumbers(plan, "doc");
    expect(numbers.get("doc.body.sub1")).toBe("2.1");
    expect(numbers.get("doc.body.sub2")).toBe("2.2");
  });
});
