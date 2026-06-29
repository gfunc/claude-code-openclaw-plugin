import type {
  AcpRuntimeEvent,
  AcpRuntimeTurnResult,
} from "openclaw/plugin-sdk/acp-runtime";
import type { ClaudeCodeState } from "../config.js";
import type { SessionStore } from "../store.js";

type EventQueue = {
  push(event: AcpRuntimeEvent): void;
  close(): void;
  next(): Promise<{ event?: AcpRuntimeEvent; done: boolean }>;
};

function createEventQueue(): EventQueue {
  const events: AcpRuntimeEvent[] = [];
  const waiters: Array<(value: { event?: AcpRuntimeEvent; done: boolean }) => void> = [];
  let closed = false;

  function resolve(value: { event?: AcpRuntimeEvent; done: boolean }): void {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter?.(value);
    }
  }

  return {
    push(event) {
      if (closed) return;
      if (waiters.length > 0) {
        resolve({ event, done: false });
      } else {
        events.push(event);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      resolve({ done: true });
    },
    next() {
      if (events.length > 0) {
        return Promise.resolve({ event: events.shift()!, done: false });
      }
      if (closed) {
        return Promise.resolve({ event: undefined, done: true });
      }
      return new Promise<{ event?: AcpRuntimeEvent; done: boolean }>((res) => waiters.push(res));
    },
  };
}

type PendingTurn = {
  requestId: string;
  sessionKey: string;
  resolveResult: (r: AcpRuntimeTurnResult) => void;
  rejectResult: (err: unknown) => void;
  queue: EventQueue;
  done: boolean;
  readOutput: () => Promise<string>;
};

function isTurnTerminalState(state: ClaudeCodeState): boolean {
  return (
    state === "DONE" ||
    state === "FATAL" ||
    state === "ERROR" ||
    state === "WAITING" ||
    state === "PERMISSION" ||
    state === "QUESTION"
  );
}

export type AcpEventStreamer = {
  startTurn(params: {
    sessionKey: string;
    requestId: string;
    tmuxSession: string;
    signal?: AbortSignal;
    timeoutMs: number;
    readOutput: () => Promise<string>;
  }): {
    events: AsyncIterable<AcpRuntimeEvent>;
    result: Promise<AcpRuntimeTurnResult>;
    cancel: () => void;
  };
  notifyState(sessionId: string, state: ClaudeCodeState): void;
  cancelTurn(sessionKey: string, requestId?: string): void;
};

export function createAcpEventStreamer(store: SessionStore): AcpEventStreamer {
  const pendingBySessionKey = new Map<string, Map<string, PendingTurn>>();

  function registerPendingTurn(sessionKey: string, pending: PendingTurn): void {
    let map = pendingBySessionKey.get(sessionKey);
    if (!map) {
      map = new Map();
      pendingBySessionKey.set(sessionKey, map);
    }
    map.set(pending.requestId, pending);
  }

  function unregisterPendingTurn(sessionKey: string, requestId: string): void {
    const map = pendingBySessionKey.get(sessionKey);
    if (!map) return;
    map.delete(requestId);
    if (map.size === 0) pendingBySessionKey.delete(sessionKey);
  }

  function resolveTerminal(
    pending: PendingTurn,
    result: AcpRuntimeTurnResult,
  ): void {
    if (pending.done) return;
    pending.done = true;
    unregisterPendingTurn(pending.sessionKey, pending.requestId);
    pending.resolveResult(result);
    pending.queue.close();
  }

  async function handleTerminalHook(
    pending: PendingTurn,
    state: ClaudeCodeState,
  ): Promise<void> {
    try {
      const output = await pending.readOutput();
      if (state === "DONE") {
        pending.queue.push({ type: "text_delta", text: output });
        pending.queue.push({ type: "done" });
        resolveTerminal(pending, { status: "completed" });
      } else if (state === "FATAL" || state === "ERROR") {
        pending.queue.push({
          type: "error",
          message: output,
          code: "ACP_TURN_FAILED",
        });
        resolveTerminal(pending, {
          status: "failed",
          error: { message: output, code: "ACP_TURN_FAILED" },
        });
      } else {
        // WAITING / PERMISSION / QUESTION: turn is complete but needs follow-up
        pending.queue.push({ type: "text_delta", text: output });
        pending.queue.push({ type: "done", stopReason: state });
        resolveTerminal(pending, { status: "completed", stopReason: state });
      }
    } catch (err) {
      const message = `failed to read output: ${String(err)}`;
      pending.queue.push({ type: "error", message, code: "ACP_TURN_FAILED" });
      resolveTerminal(pending, {
        status: "failed",
        error: { message, code: "ACP_TURN_FAILED" },
      });
    }
  }

  return {
    startTurn(params) {
      let resolveResult!: (r: AcpRuntimeTurnResult) => void;
      let rejectResult!: (err: unknown) => void;
      const result = new Promise<AcpRuntimeTurnResult>((res, rej) => {
        resolveResult = res;
        rejectResult = rej;
      });

      const queue = createEventQueue();
      const pending: PendingTurn = {
        requestId: params.requestId,
        sessionKey: params.sessionKey,
        resolveResult,
        rejectResult,
        queue,
        done: false,
        readOutput: params.readOutput,
      };
      registerPendingTurn(params.sessionKey, pending);

      const timeoutTimer = setTimeout(() => {
        if (pending.done) return;
        queue.push({
          type: "error",
          message: "Turn timed out waiting for terminal hook",
          code: "ACP_TURN_FAILED",
        });
        resolveTerminal(pending, {
          status: "failed",
          error: {
            message: "Turn timed out waiting for terminal hook",
            code: "ACP_TURN_FAILED",
          },
        });
      }, params.timeoutMs);

      function cleanup(): void {
        clearTimeout(timeoutTimer);
        unregisterPendingTurn(params.sessionKey, params.requestId);
      }

      if (params.signal) {
        params.signal.addEventListener("abort", () => {
          if (pending.done) return;
          queue.push({ type: "error", message: "Turn aborted", code: "ACP_TURN_FAILED" });
          resolveTerminal(pending, {
            status: "failed",
            error: { message: "Turn aborted", code: "ACP_TURN_FAILED" },
          });
        });
      }

      async function* gen(): AsyncGenerator<AcpRuntimeEvent> {
        queue.push({ type: "status", text: "Claude Code is working..." });
        while (true) {
          const { event, done } = await queue.next();
          if (done) break;
          if (event) yield event;
        }
      }

      return {
        events: gen(),
        result: result.finally(cleanup),
        cancel: () => {
          if (pending.done) return;
          queue.push({ type: "error", message: "Turn cancelled", code: "ACP_TURN_FAILED" });
          resolveTerminal(pending, { status: "cancelled" });
        },
      };
    },

    notifyState(sessionId, state) {
      const sessionKey = store
        .listStates()
        .find((s) => s.sessionId === sessionId)?.sessionKey;
      if (!sessionKey) return;
      const map = pendingBySessionKey.get(sessionKey);
      if (!map || map.size === 0) return;
      const pending = map.values().next().value as PendingTurn | undefined;
      if (!pending || pending.done) return;

      if (isTurnTerminalState(state)) {
        void handleTerminalHook(pending, state);
      }
      // Non-terminal state transitions are ignored; the status event was already emitted.
    },

    cancelTurn(sessionKey, requestId) {
      const map = pendingBySessionKey.get(sessionKey);
      if (!map || map.size === 0) return;
      if (requestId) {
        const pending = map.get(requestId);
        if (!pending || pending.done) return;
        pending.queue.push({ type: "error", message: "Turn cancelled", code: "ACP_TURN_FAILED" });
        resolveTerminal(pending, { status: "cancelled" });
        return;
      }
      for (const pending of map.values()) {
        if (pending.done) continue;
        pending.queue.push({ type: "error", message: "Turn cancelled", code: "ACP_TURN_FAILED" });
        resolveTerminal(pending, { status: "cancelled" });
      }
    },
  };
}
