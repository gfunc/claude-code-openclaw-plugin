import { resolveBehavior } from "./behavior.js";
import type { ClaudeCodeState } from "./config.js";
import type { SessionState } from "./state.js";

export type BehaviorDispatcher = {
  onStateChanged(state: SessionState): void;
  getPendingAnnounceSessionIds(): string[];
};

export type HeartbeatRequestOptions = {
  source: "hook";
  intent: "immediate";
  reason: "claude-code-state-change";
  sessionKey: string;
};

export function createBehaviorDispatcher(options: {
  enqueueSystemEvent: (text: string, opts: { sessionKey: string; contextKey: string }) => boolean;
  requestHeartbeat?: (opts: HeartbeatRequestOptions) => void;
  notifyStates: ClaudeCodeState[];
  sessionKey: string;
}): BehaviorDispatcher {
  const { enqueueSystemEvent, requestHeartbeat, notifyStates, sessionKey } = options;
  const announcedOnce = new Set<string>();
  const lastHeartbeatBySessionId = new Map<string, number>();
  const HEARTBEAT_THROTTLE_MS = 1000;

  function onStateChanged(state: SessionState): void {
    const behavior = resolveBehavior(state.state, notifyStates);
    if (!behavior.announce) return;
    if (behavior.oneShotAnnounce && announcedOnce.has(state.sessionId)) return;
    if (behavior.oneShotAnnounce) announcedOnce.add(state.sessionId);

    const text = `${behavior.prefix} Claude Code session ${state.tmuxSession ?? state.sessionId} is ${behavior.message}`;
    let enqueued = false;
    try {
      enqueued = enqueueSystemEvent(text, { sessionKey, contextKey: state.sessionId });
    } catch (err) {
      // Best-effort: don't let notification failures break hook processing.
      // eslint-disable-next-line no-console
      console.error("claude-code: enqueueSystemEvent failed:", err);
      return;
    }

    if (!enqueued || !requestHeartbeat) return;

    const now = Date.now();
    const lastHeartbeat = lastHeartbeatBySessionId.get(state.sessionId) ?? 0;
    if (now - lastHeartbeat < HEARTBEAT_THROTTLE_MS) return;
    lastHeartbeatBySessionId.set(state.sessionId, now);

    try {
      requestHeartbeat({
        source: "hook",
        intent: "immediate",
        reason: "claude-code-state-change",
        sessionKey,
      });
    } catch (err) {
      // Best-effort: heartbeat failure must not break hook processing.
      // eslint-disable-next-line no-console
      console.error("claude-code: requestHeartbeat failed:", err);
    }
  }

  function getPendingAnnounceSessionIds(): string[] {
    return [];
  }

  return { onStateChanged, getPendingAnnounceSessionIds };
}
