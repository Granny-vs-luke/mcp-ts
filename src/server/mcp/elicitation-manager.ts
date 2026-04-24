/**
 * ElicitationManager
 *
 * Server-side registry of pending elicitation requests.
 *
 * Lifecycle of one elicitation:
 *   1. `mcp_elicit_input` meta-tool calls `elicit(id, timeout)` — creates a Promise and stores it.
 *   2. The SSE `elicitation` event is emitted to the client (done by the meta-tool via EmitElicitationFn).
 *   3. The user submits the form. Client POSTs `elicitationRespond` with `{ elicitationId, data }`.
 *   4. `SSEConnectionManager.handleRequest` calls `respond(id, data)` — resolves the pending Promise.
 *   5. The meta-tool resumes with the user data as its return value.
 *
 * On connection close, `rejectAll` is called so no promises hang indefinitely.
 */
export class ElicitationManager {
  /** Default time (ms) to wait for a user response before auto-rejecting */
  private static readonly DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

  private readonly pending = new Map<
    string,
    {
      resolve: (data: Record<string, unknown>) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /**
   * Register a new pending elicitation and return a Promise that resolves
   * when the user responds (or rejects after `timeoutMs`).
   *
   * @param elicitationId  Unique ID for this elicitation round-trip.
   * @param timeoutMs      How long to wait before auto-rejecting. Default 2 min.
   */
  elicit(
    elicitationId: string,
    timeoutMs: number = ElicitationManager.DEFAULT_TIMEOUT_MS
  ): Promise<Record<string, unknown>> {
    // If there's already a pending elicitation with the same ID, reject it first
    // (shouldn't happen in practice, but guards against ID collisions).
    if (this.pending.has(elicitationId)) {
      const existing = this.pending.get(elicitationId)!;
      clearTimeout(existing.timer);
      existing.reject(new Error(`Elicitation ${elicitationId} was superseded`));
      this.pending.delete(elicitationId);
    }

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let entry: {
        resolve: (data: Record<string, unknown>) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      };

      const timer = setTimeout(() => {
        // Guard against stale timer callbacks: only reject/delete if this callback
        // still corresponds to the currently registered entry for the same ID.
        if (this.pending.get(elicitationId) === entry) {
          this.pending.delete(elicitationId);
          reject(new Error(`Elicitation "${elicitationId}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      entry = { resolve, reject, timer };
      this.pending.set(elicitationId, entry);
    });
  }

  /**
   * Resolve a pending elicitation with the user's submitted data.
   *
   * @param elicitationId  ID that matches a previously emitted elicitation event.
   * @param data           User-provided form data.
   * @returns `true` if the elicitation was found and resolved; `false` if it
   *          had already timed out or never existed.
   */
  respond(elicitationId: string, data: Record<string, unknown>): boolean {
    const entry = this.pending.get(elicitationId);
    if (!entry) {
      return false; // Already timed out or unknown ID
    }

    clearTimeout(entry.timer);
    this.pending.delete(elicitationId);
    entry.resolve(data);
    return true;
  }

  /**
   * Reject all pending elicitations — call this when the SSE connection closes
   * so tool handlers don't hang forever waiting for user input.
   */
  rejectAll(reason = 'SSE connection closed'): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`${reason} (elicitationId: ${id})`));
    }
    this.pending.clear();
  }

  /** Number of currently pending elicitations (useful for observability). */
  get pendingCount(): number {
    return this.pending.size;
  }
}
