import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createHasher, curriculumItemFromPlan, learningConsentInput, listHeldSources, reviewHeldSource, type HeldSource } from "@scce/kernel";
import type { createNodeRuntime } from "@scce/adapters-node";

/** Ask-before-learning at the terminal: consent to search, then confirm each fetched source is true before it becomes knowledge. */

type Runtime = ReturnType<typeof createNodeRuntime>;
type TurnLike = { runtimeMotion?: unknown; answer?: string };
interface Motion { status?: string; consent?: { planId?: string }; heldSources?: Array<{ id: string; uri: string; title?: string; snippet?: string }> }

function motionOf(result: TurnLike): Motion | undefined {
  const motion = result.runtimeMotion;
  return motion && typeof motion === "object" && !Array.isArray(motion) ? motion as Motion : undefined;
}

function printHeld(source: HeldSource | { id: string; uri: string; title?: string; preview?: string; snippet?: string }): void {
  process.stdout.write(`- ${source.id}\n  ${source.title ? `${source.title} ` : ""}${source.uri}\n  ${String(("preview" in source && source.preview) || ("snippet" in source && source.snippet) || "").slice(0, 400)}\n`);
}

export async function negotiateLearning<T extends TurnLike>(runtime: Runtime, turn: () => Promise<T>, result: T): Promise<T> {
  const motion = motionOf(result);
  if (!motion) return result;
  if (motion.status === "awaiting_consent" && motion.consent?.planId) {
    if (!stdin.isTTY) {
      process.stdout.write(`\nNo evidence on this yet. To let SCCE search the web and learn it, approve plan ${motion.consent.planId} (scce learn consent <planId>) and ask again.\n`);
      return result;
    }
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await rl.question("\nNo evidence on this yet. Search the web and learn it? [y/N] ")).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") return result;
    } finally { rl.close(); }
    runtime.approvals.approve(motion.consent.planId);
    return negotiateLearning(runtime, turn, await turn());
  }
  if (motion.status === "held_for_review" && motion.heldSources?.length) {
    process.stdout.write("\nFound material but have not learned it yet:\n");
    for (const source of motion.heldSources) printHeld(source);
    if (!stdin.isTTY) {
      process.stdout.write("Confirm with: scce learn confirm <id> | reject <id>, then ask again.\n");
      return result;
    }
    const rl = createInterface({ input: stdin, output: stdout });
    let promoted = 0;
    try {
      for (const source of motion.heldSources) {
        const answer = (await rl.question(`Is ${source.uri} true? keep it [y/N] `)).trim().toLowerCase();
        const review = await reviewHeldSource(runtime.storage, { id: source.id, decision: answer === "y" || answer === "yes" ? "promoted" : "rejected", reviewer: "owner" });
        if (review.decision === "promoted") promoted += review.promotedEvidence;
      }
    } finally { rl.close(); }
    return promoted > 0 ? negotiateLearning(runtime, turn, await turn()) : result;
  }
  return result;
}

export async function runLearnCommand(runtime: Runtime, args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "pending" || !sub) {
    const held = await listHeldSources(runtime.storage, 50);
    if (!held.length) { process.stdout.write("nothing is waiting for your review\n"); return; }
    for (const source of held) printHeld(source);
    return;
  }
  if ((sub === "confirm" || sub === "reject") && args[1]) {
    const review = await reviewHeldSource(runtime.storage, { id: args[1], decision: sub === "confirm" ? "promoted" : "rejected", reviewer: "owner" });
    process.stdout.write(`${review.decision} ${review.uri} (${review.promotedEvidence} evidence spans promoted)\n`);
    return;
  }
  if (sub === "curriculum") {
    const items = runtime.approvals.snapshot().pending.map(record => curriculumItemFromPlan({ id: record.planId as never, capabilityId: record.capabilityId, input: record.input })).filter(Boolean);
    if (!items.length) { process.stdout.write("no self-proposed learning is waiting for consent in this session\n"); return; }
    for (const item of items) process.stdout.write(`- ${item!.planId}\n  wants to learn: ${item!.query}\n  ${item!.rationale}\n`);
    return;
  }
  if (sub === "pursue" && args[1]) {
    const record = runtime.approvals.snapshot().pending.find(item => item.planId === args[1]);
    const item = record ? curriculumItemFromPlan({ id: record.planId as never, capabilityId: record.capabilityId, input: record.input }) : undefined;
    if (!item) throw new Error(`no pending curriculum item ${args[1]}; see: scce learn curriculum`);
    runtime.approvals.approve(item.planId);
    const consent = runtime.approvals.requestApproval({ capabilityId: "network.search", input: learningConsentInput(item.query, createHasher()), reason: "owner-consent-required" });
    runtime.approvals.approve(consent.planId);
    const turn = () => runtime.kernel.turn({ text: item.query, metadata: { conversationId: `curriculum:${item.planId}`, sessionId: `curriculum:${item.planId}` } });
    const result = await negotiateLearning(runtime, turn, await turn());
    process.stdout.write(`${result.answer}\n`);
    return;
  }
  if (sub === "consent" && args[1]) {
    runtime.approvals.approve(args[1]);
    process.stdout.write(`consent recorded for ${args[1]} in this process; ask again in the same session to search\n`);
    return;
  }
  throw new Error("usage: scce learn pending | confirm <id> | reject <id> | curriculum | pursue <planId>");
}
