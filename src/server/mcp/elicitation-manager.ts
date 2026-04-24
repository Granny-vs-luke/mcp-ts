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
/** The resolved response from a user elicitation */
export interface ElicitationResponse {
  action: 'accept' | 'decline' | 'cancel';
  /** Present only when action === 'accept' */
  data?: Record<string, unknown>;
}

export class ElicitationManager {
  /** Default time (ms) to wait for a user response before auto-rejecting */
  private static readonly DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

  private readonly pending = new Map<
    string,
    {
      resolve: (response: ElicitationResponse) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /**
   * Register a new pending elicitation and return a Promise that resolves
   * when the user responds (or rejects after `timeoutMs`).
   */
  elicit(
    elicitationId: string,
    timeoutMs: number = ElicitationManager.DEFAULT_TIMEOUT_MS
  ): Promise<ElicitationResponse> {
    if (this.pending.has(elicitationId)) {
      const existing = this.pending.get(elicitationId)!;
      clearTimeout(existing.timer);
      existing.reject(new Error(`Elicitation ${elicitationId} was superseded`));
      this.pending.delete(elicitationId);
    }

    return new Promise<ElicitationResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(elicitationId)) {
          this.pending.delete(elicitationId);
          reject(new Error(`Elicitation "${elicitationId}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pending.set(elicitationId, { resolve, reject, timer });
    });
  }

  /**
   * Resolve a pending elicitation with the user's response.
   *
   * @param elicitationId  ID that matches a previously emitted elicitation event.
   * @param response       The user's response (action + optional data).
   * @returns `true` if found and resolved; `false` if already timed out or unknown.
   */
  respond(elicitationId: string, response: ElicitationResponse): boolean {
    const entry = this.pending.get(elicitationId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(elicitationId);
    entry.resolve(response);
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
