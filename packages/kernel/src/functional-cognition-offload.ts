import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  FunctionalCognitionOffloadRequest,
  FunctionalCognitionOffloadResponse
} from "./functional-cognition-offload-contract.js";
import { positiveRuntimeInt } from "./runtime-graph-cache.js";

/**
 * Runs the (self-distillation + consciousness scoring + goal/policy
 * projection) computation in a short-lived child process with a hard,
 * separate V8 heap cap, mirroring the wikipedia ingestor's child-process +
 * `--max-old-space-size` heap-safety pattern (and this codebase's existing
 * spreadsheet.ts/spreadsheet-process.ts precedent) instead of an in-process
 * concurrency counter. On a memory-constrained consumer machine sharing RAM
 * with the OS, an editor, and Postgres, this is the real fix: the parent
 * process's heap is never at risk from this work, no matter how large
 * `graph` or how long the computation runs, because it happens in a
 * separate address space with its own enforced ceiling.
 */
export async function runFunctionalCognitionOffProcess(
  input: FunctionalCognitionOffloadRequest
): Promise<{ selfDistillationAudit: unknown; functionalConsciousnessAudit: unknown; functionalCognitionAudit: unknown; gate?: import("./functional-cognition.js").FunctionalSelectionGate }> {
  const heapMb = positiveRuntimeInt("SCCE_FUNCTIONAL_COGNITION_CHILD_HEAP_MB", 384);
  const timeoutMs = positiveRuntimeInt("SCCE_FUNCTIONAL_COGNITION_CHILD_TIMEOUT_MS", 60_000);
  const processPath = fileURLToPath(functionalCognitionProcessUrl());
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = fork(processPath, [], {
      execArgv: [
        `--max-old-space-size=${heapMb}`,
        `--max-semi-space-size=${Math.max(16, Math.min(64, Math.floor(heapMb / 4)))}`
      ],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      finish(() => {
        child.kill();
        reject(new Error(`functional-cognition offload exceeded ${timeoutMs}ms`));
      });
    }, timeoutMs);
    child.once("message", (message: FunctionalCognitionOffloadResponse) => {
      finish(() => {
        child.kill();
        if (message.ok) {
          resolve({
            selfDistillationAudit: message.selfDistillationAudit,
            functionalConsciousnessAudit: message.functionalConsciousnessAudit,
            functionalCognitionAudit: message.functionalCognitionAudit,
            gate: message.gate
          });
        } else {
          reject(new Error(message.error || "functional-cognition offload process returned no result"));
        }
      });
    });
    child.once("error", error => finish(() => reject(new Error(`functional-cognition offload process failed: ${error.message}`))));
    child.once("exit", code => {
      if (code !== 0) finish(() => reject(new Error(`functional-cognition offload process exited with code ${code}`)));
      else finish(() => reject(new Error("functional-cognition offload process exited before returning a result")));
    });
    child.send(input, error => {
      if (error) finish(() => reject(new Error(`functional-cognition offload process IPC failed: ${error.message}`)));
    });
  });
}

function functionalCognitionProcessUrl(): URL {
  const colocated = new URL("./functional-cognition-process.js", import.meta.url);
  if (existsSync(fileURLToPath(colocated))) return colocated;
  throw new Error("functional-cognition offload process is unavailable; build @scce/kernel before running turns");
}
