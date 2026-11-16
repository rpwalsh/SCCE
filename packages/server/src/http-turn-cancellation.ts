// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { IncomingMessage, ServerResponse } from "node:http";

/** A synchronous HTTP turn belongs to its response; durable tasks use their own controller. */
export function bindHttpTurnCancellation(req: IncomingMessage, res: ServerResponse): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      const reason = new Error("runtime.http.client_disconnected");
      reason.name = "AbortError";
      controller.abort(reason);
    }
  };
  const responseClosed = () => { if (!res.writableFinished) abort(); };
  req.once("aborted", abort);
  res.once("close", responseClosed);
  if (req.aborted || res.destroyed && !res.writableFinished) abort();
  return { signal: controller.signal, dispose() { req.off("aborted", abort); res.off("close", responseClosed); } };
}

export function httpResponseClosed(res: ServerResponse): boolean { return res.destroyed || res.writableEnded; }
