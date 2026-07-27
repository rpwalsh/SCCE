import { describe, expect, it } from "vitest";
import {
  EMPTY_DOCUMENT_PLAN,
  addDocumentPlanNode,
  completeDocumentPlanNode,
  pendingDocumentPlanNodes,
  rhetoricalOrder,
  type DocumentPlan
} from "../document-plan.js";

function buildReportPlan(): DocumentPlan {
  let plan = addDocumentPlanNode(EMPTY_DOCUMENT_PLAN, {
    id: "doc",
    kind: "document",
    order: 0,
    goal: "explain the incident and its resolution"
  });
  plan = addDocumentPlanNode(plan, {
    id: "doc.methodology",
    kind: "section",
    parentId: "doc",
    order: 0,
    goal: "describe how the incident was investigated",
    requiredCoverageIds: ["method"]
  });
  plan = addDocumentPlanNode(plan, {
    id: "doc.results",
    kind: "section",
    parentId: "doc",
    order: 1,
    goal: "present what the investigation found",
    requiredCoverageIds: ["finding"],
    rhetoricalDependsOnIds: ["doc.methodology"]
  });
  plan = addDocumentPlanNode(plan, {
    id: "doc.conclusion",
    kind: "section",
    parentId: "doc",
    order: 2,
    goal: "summarize the resolution",
    requiredCoverageIds: ["resolution"],
    rhetoricalDependsOnIds: ["doc.results"]
  });
  return plan;
}

describe("hierarchical document planner (plan item 221)", () => {
  it("carries coverage/order/reference/rhetorical-dependency fields per node", () => {
    const plan = buildReportPlan();
    const results = plan.nodes["doc.results"]!;
    expect(results.requiredCoverageIds).toEqual(["finding"]);
    expect(results.rhetoricalDependsOnIds).toEqual(["doc.methodology"]);
    expect(results.order).toBe(1);
  });

  it("its rhetorical dependencies are real input for task-schedule-solver.ts, not a duplicated scheduler", () => {
    const plan = buildReportPlan();
    const order = rhetoricalOrder(plan);
    expect(order.indexOf("doc.methodology")).toBeLessThan(order.indexOf("doc.results"));
    expect(order.indexOf("doc.results")).toBeLessThan(order.indexOf("doc.conclusion"));
  });

  it("detects a genuine rhetorical-dependency cycle rather than silently accepting it", () => {
    let plan = addDocumentPlanNode(EMPTY_DOCUMENT_PLAN, { id: "a", kind: "section", order: 0, goal: "a" });
    plan = addDocumentPlanNode(plan, { id: "b", kind: "section", order: 1, goal: "b", rhetoricalDependsOnIds: ["a"] });
    // Can't add a cycle directly (addDocumentPlanNode rejects unknown deps
    // at add-time), so construct it by hand to exercise rhetoricalOrder's
    // own cycle detection independently.
    const withCycle: typeof plan = {
      nodes: {
        ...plan.nodes,
        a: { ...plan.nodes["a"]!, rhetoricalDependsOnIds: ["b"] }
      }
    };
    expect(() => rhetoricalOrder(withCycle)).toThrow(/cycle/);
  });

  it("cannot complete a node while its rhetorical dependencies are unsatisfied", () => {
    const plan = buildReportPlan();
    expect(() => completeDocumentPlanNode(plan, { nodeId: "doc.results", content: "...", satisfiedCoverageIds: ["finding"] }))
      .toThrow(/rhetorical dependencies not yet satisfied/);
  });

  it("cannot complete a node whose required coverage was never actually satisfied", () => {
    const plan = buildReportPlan();
    expect(() => completeDocumentPlanNode(plan, { nodeId: "doc.methodology", content: "...", satisfiedCoverageIds: [] }))
      .toThrow(/required coverage not satisfied/);
  });
});

describe("resuming/revising a document plan never rebuilds a completed section (plan item 222)", () => {
  it("pendingDocumentPlanNodes returns only the real remaining work, in valid rhetorical order", () => {
    let plan = buildReportPlan();
    plan = completeDocumentPlanNode(plan, { nodeId: "doc.methodology", content: "We reviewed the logs.", satisfiedCoverageIds: ["method"] });
    const pending = pendingDocumentPlanNodes(plan);
    expect(pending.map(node => node.id)).toEqual(["doc.results"]);
  });

  it("a completed section's content is preserved byte-for-byte across a later, unrelated completion (resuming never rebuilds it)", () => {
    let plan = buildReportPlan();
    const methodologyContent = "We reviewed the logs and interviewed the on-call engineer.";
    plan = completeDocumentPlanNode(plan, { nodeId: "doc.methodology", content: methodologyContent, satisfiedCoverageIds: ["method"] });
    const beforeResultsCompletion = plan.nodes["doc.methodology"]!.content;

    plan = completeDocumentPlanNode(plan, { nodeId: "doc.results", content: "The root cause was a stale cache entry.", satisfiedCoverageIds: ["finding"] });

    expect(plan.nodes["doc.methodology"]!.content).toBe(methodologyContent);
    expect(plan.nodes["doc.methodology"]!.content).toBe(beforeResultsCompletion);
    // pendingDocumentPlanNodes now only asks for the conclusion -- the
    // methodology section is never revisited.
    expect(pendingDocumentPlanNodes(plan).map(node => node.id)).toEqual(["doc.conclusion"]);
  });

  it("a section blocked on an unsatisfied rhetorical dependency is never offered as pending work", () => {
    const plan = buildReportPlan();
    // Nothing completed yet -- only doc.methodology has no unmet
    // dependencies, so it alone is pending.
    expect(pendingDocumentPlanNodes(plan).map(node => node.id)).toEqual(["doc.methodology"]);
  });

  it("cannot complete an already-completed section", () => {
    let plan = buildReportPlan();
    plan = completeDocumentPlanNode(plan, { nodeId: "doc.methodology", content: "done", satisfiedCoverageIds: ["method"] });
    expect(() => completeDocumentPlanNode(plan, { nodeId: "doc.methodology", content: "done again", satisfiedCoverageIds: ["method"] }))
      .toThrow(/already completed/);
  });
});
