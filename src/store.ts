import fs from "node:fs/promises";
import path from "node:path";
import type { PluginConfig } from "./config.js";
import type { DiscoveredSession } from "./discovery.js";
import { formatHookLogLine, type SessionEventLogger } from "./event-log.js";
import type { ClaudeCodeHookPayload, DeliveryContext, SessionState } from "./state.js";
import { applyHook as applyHookState, buildInitialState } from "./state.js";

export type SessionStoreOptions = Pick<PluginConfig, "stateFileDir"> & {
  flushDebounceMs?: number;
  eventLogger?: SessionEventLogger;
};

export type SessionStore = ReturnType<typeof createSessionStore>;

export function createSessionStore(options: SessionStoreOptions) {
  const stateDir = options.stateFileDir;
  const flushDebounceMs = options.flushDebounceMs ?? 250;
  const eventLogger = options.eventLogger;
  const sessions = new Map<string, SessionState>();
  const pendingNotifyContext = new Map<
    string,
    {
      runId: string;
      notifySessionKey: string;
      notifyDeliveryContext?: DeliveryContext;
    }
  >();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function statePath(sessionId: string): string {
    return path.join(stateDir, `${sessionId}.json`);
  }

  function notifySidecarPath(sessionId: string): string {
    return path.join(stateDir, `${sessionId}.notify.json`);
  }

  async function readNotifySidecar(
    sessionId: string,
  ): Promise<
    | {
        runId: string;
        notifySessionKey: string;
        notifyDeliveryContext?: DeliveryContext;
      }
    | undefined
  > {
    try {
      const content = await fs.readFile(notifySidecarPath(sessionId), "utf8");
      const parsed = JSON.parse(content) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as Record<string, unknown>).notifySessionKey === "string"
      ) {
        return parsed as {
          runId: string;
          notifySessionKey: string;
          notifyDeliveryContext?: DeliveryContext;
        };
      }
    } catch {
      // sidecar missing or unreadable
    }
    return undefined;
  }

  async function flush(): Promise<void> {
    await fs.mkdir(stateDir, { recursive: true });
    await Promise.all(
      Array.from(sessions.values()).map((state) => {
        const file = statePath(state.sessionId);
        return fs.writeFile(file, JSON.stringify(state, null, 2) + "\n", "utf8");
      }),
    );
  }

  function scheduleFlush(): void {
    if (disposed) {
      void flush();
      return;
    }
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      void flush();
    }, flushDebounceMs);
  }

  async function applyHook(
    payload: ClaudeCodeHookPayload,
    discover?: () => Promise<DiscoveredSession | undefined>,
  ): Promise<SessionState> {
    const prev = sessions.get(payload.session_id);
    const prevState = prev?.state;
    let state = prev;
    if (!state) {
      state = buildInitialState(payload);
      const found = discover ? await discover() : undefined;
      if (found) {
        state.tmuxSession = found.tmuxSession;
        state.logFile = found.logFile;
        state.workdir = found.workdir ?? state.workdir;
        state.budgetMinutes = found.budgetMinutes;
        if (found.budgetMinutes) {
          state.budgetDeadline = Date.now() + found.budgetMinutes * 60_000;
        }
      }
      const pending = pendingNotifyContext.get(payload.session_id);
      if (pending) {
        eventLogger?.log(
          payload.session_id,
          `APPLY_PENDING_NOTIFY notifySessionKey=${pending.notifySessionKey} deliveryContext=${pending.notifyDeliveryContext ? JSON.stringify(pending.notifyDeliveryContext) : "undefined"}`,
        );
        state.runId = pending.runId;
        state.notifySessionKey = pending.notifySessionKey;
        state.notifyDeliveryContext = pending.notifyDeliveryContext;
        pendingNotifyContext.delete(payload.session_id);
      } else if (!state.notifySessionKey) {
        const sidecar = await readNotifySidecar(payload.session_id);
        if (sidecar) {
          eventLogger?.log(
            payload.session_id,
            `APPLY_SIDECAR_NOTIFY notifySessionKey=${sidecar.notifySessionKey} deliveryContext=${sidecar.notifyDeliveryContext ? JSON.stringify(sidecar.notifyDeliveryContext) : "undefined"}`,
          );
          state.runId = sidecar.runId;
          state.notifySessionKey = sidecar.notifySessionKey;
          state.notifyDeliveryContext = sidecar.notifyDeliveryContext;
        }
      }
      // Best-effort cleanup: the sidecar is a one-time routing token.
      await fs.rm(notifySidecarPath(payload.session_id), { force: true }).catch(() => {});
      sessions.set(payload.session_id, state);
    } else {
      state = applyHookState(state, payload);
      eventLogger?.log(
        payload.session_id,
        `APPLY_HOOK_UPDATE notifySessionKey=${state.notifySessionKey ?? "undefined"} deliveryContext=${state.notifyDeliveryContext ? JSON.stringify(state.notifyDeliveryContext) : "undefined"}`,
      );
      sessions.set(payload.session_id, state);
    }
    if (eventLogger) {
      const lastEvt = state.history[state.history.length - 1];
      eventLogger.log(
        payload.session_id,
        formatHookLogLine({
          ts: state.lastSeenAt,
          event: state.lastHookEvent,
          prevState,
          newState: state.state,
          tool: lastEvt?.tool,
        }),
      );
    }
    scheduleFlush();
    return state;
  }

  function markFatal(sessionId: string, reason: string): SessionState | undefined {
    const state = sessions.get(sessionId);
    if (!state || state.state === "FATAL") return state;
    const now = Date.now();
    const updated: SessionState = {
      ...state,
      state: "FATAL",
      fatalReason: reason,
      stateSince: now,
      lastSeenAt: now,
      history: [...state.history, { ts: now, state: "FATAL", event: state.lastHookEvent }],
    };
    sessions.set(sessionId, updated);
    scheduleFlush();
    return updated;
  }

  async function loadFromDisk(): Promise<number> {
    let count = 0;
    try {
      const files = await fs.readdir(stateDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));
      for (const file of jsonFiles) {
        try {
          const content = await fs.readFile(path.join(stateDir, file), "utf8");
          const parsed = JSON.parse(content) as unknown;
          if (parsed && typeof parsed === "object" && "sessionId" in parsed && typeof (parsed as Record<string, unknown>).sessionId === "string") {
            sessions.set((parsed as SessionState).sessionId, parsed as SessionState);
            count++;
          }
        } catch {
          // skip files that fail to parse or lack sessionId
        }
      }
    } catch {
      // stateDir does not exist or is not readable
    }
    return count;
  }

  function getState(sessionId: string): SessionState | undefined {
    return sessions.get(sessionId);
  }

  function setNotifyContext(
    sessionId: string,
    params: {
      runId: string;
      notifySessionKey: string;
      notifyDeliveryContext?: DeliveryContext;
    },
  ): void {
    eventLogger?.log(
      sessionId,
      `SET_NOTIFY_CONTEXT runId=${params.runId} notifySessionKey=${params.notifySessionKey} deliveryContext=${params.notifyDeliveryContext ? JSON.stringify(params.notifyDeliveryContext) : "undefined"}`,
    );
    const state = sessions.get(sessionId);
    if (state) {
      state.runId = params.runId;
      state.notifySessionKey = params.notifySessionKey;
      state.notifyDeliveryContext = params.notifyDeliveryContext;
      scheduleFlush();
    } else {
      pendingNotifyContext.set(sessionId, params);
    }
  }

  function listStates(): SessionState[] {
    return Array.from(sessions.values());
  }

  async function dispose(): Promise<void> {
    disposed = true;
    if (flushTimer) clearTimeout(flushTimer);
    await flush();
  }

  return {
    applyHook,
    markFatal,
    getState,
    listStates,
    loadFromDisk,
    dispose,
    setNotifyContext,
  };
}
