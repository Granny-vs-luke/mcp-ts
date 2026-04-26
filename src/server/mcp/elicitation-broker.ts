import { nanoid } from 'nanoid';
import type { ElicitationResponse } from './elicitation-manager.js';

export interface ElicitationBrokerRequest {
  elicitationId: string;
  identity?: string;
  sessionId?: string;
  serverId?: string;
  mode: 'form' | 'url';
  message: string;
  requestedSchema?: Record<string, unknown>;
  url?: string;
  timestamp: number;
}

export type ElicitationBrokerRequestInput = Omit<
  ElicitationBrokerRequest,
  'elicitationId' | 'timestamp'
> & {
  elicitationId?: string;
};

type PendingRequest = {
  resolve: (response: ElicitationResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ElicitationBrokerListener = (request: ElicitationBrokerRequest) => void;

export class ElicitationBroker {
  private static readonly DEFAULT_TIMEOUT_MS = 120_000;

  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<ElicitationBrokerListener>();

  request(
    input: ElicitationBrokerRequestInput,
    timeoutMs: number = ElicitationBroker.DEFAULT_TIMEOUT_MS
  ): Promise<ElicitationResponse> {
    const request: ElicitationBrokerRequest = {
      ...input,
      elicitationId: input.elicitationId ?? `elicit_${nanoid(12)}`,
      timestamp: Date.now(),
    };

    if (this.pending.has(request.elicitationId)) {
      const existing = this.pending.get(request.elicitationId)!;
      clearTimeout(existing.timer);
      existing.reject(new Error(`Elicitation ${request.elicitationId} was superseded`));
      this.pending.delete(request.elicitationId);
    }

    const promise = new Promise<ElicitationResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(request.elicitationId)) {
          this.pending.delete(request.elicitationId);
          reject(new Error(`Elicitation "${request.elicitationId}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pending.set(request.elicitationId, { resolve, reject, timer });
    });

    for (const listener of this.listeners) {
      listener(request);
    }

    return promise;
  }

  respond(elicitationId: string, response: ElicitationResponse): boolean {
    const pending = this.pending.get(elicitationId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timer);
    this.pending.delete(elicitationId);
    pending.resolve(response);
    return true;
  }

  subscribe(listener: ElicitationBrokerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clearAll(reason = 'Elicitation broker cleared'): void {
    for (const [elicitationId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${reason} (elicitationId: ${elicitationId})`));
    }
    this.pending.clear();
    this.listeners.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

const globalForElicitationBroker = globalThis as unknown as {
  __mcpTsElicitationBroker?: ElicitationBroker;
};

export function getElicitationBroker(): ElicitationBroker {
  if (!globalForElicitationBroker.__mcpTsElicitationBroker) {
    globalForElicitationBroker.__mcpTsElicitationBroker = new ElicitationBroker();
  }

  return globalForElicitationBroker.__mcpTsElicitationBroker;
}
