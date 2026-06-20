import fs from "node:fs/promises";
import path from "node:path";
import type { PluginConfig } from "./config.js";
import type { DiscoveredSession } from "./discovery.js";
import type { ClaudeCodeHookPayload, SessionState } from "./state.js";
import { applyHook as applyHookState, buildInitialState } from "./state.js";

export type SessionStoreOptions = Pick<PluginConfig, "stateFileDir"> & {
  flushDebounceMs?: number;
};

export type SessionStore = ReturnType<typeof createSessionStore>;

export function createSessionStore(options: SessionStoreOptions) {
  const stateDir = options.stateFileDir;
  const flushDebounceMs = options.flushDebounceMs ?? 250;
  const sessions = new Map<string, SessionState>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function statePath(sessionId: string): string {
    return path.join(stateDir, `${sessionId}.json`);
  }

  async function flush(): Promise<void> {
    if (disposed) return;
    await fs.mkdir(stateDir, { recursive: true });
    await Promise.all(
      Array.from(sessions.values()).map((state) => {
        const file = statePath(state.sessionId);
        return fs.writeFile(file, JSON.stringify(state, null, 2) + "\n", "utf8");
      }),
    );
  }

  function scheduleFlush(): void {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      void flush();
    }, flushDebounceMs);
  }

  async function applyHook(
    payload: ClaudeCodeHookPayload,
    discover?: () => Promise<DiscoveredSession | undefined>,
  ): Promise<SessionState> {
    let state = sessions.get(payload.session_id);
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
      sessions.set(payload.session_id, state);
    } else {
      state = applyHookState(state, payload);
      sessions.set(payload.session_id, state);
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
      stateSince: now,
      lastSeenAt: now,
      history: [...state.history, { ts: now, state: "FATAL", event: state.lastHookEvent }],
    };
    sessions.set(sessionId, updated);
    scheduleFlush();
    return updated;
  }

  function getState(sessionId: string): SessionState | undefined {
    return sessions.get(sessionId);
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
    dispose,
  };
}
