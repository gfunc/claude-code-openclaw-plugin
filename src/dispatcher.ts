import { resolveBehavior } from "./behavior.js";
import type { ClaudeCodeState } from "./config.js";
import type { ClaudeCodeHookPayload, SessionState } from "./state.js";

export type BehaviorDispatcher = {
  onStateChanged(state: SessionState): void;
  getPendingAnnounceSessionIds(): string[];
};

// Matches the OpenClaw runtime `requestHeartbeatNow` signature
// (src/infra/heartbeat-wake.ts). Extra fields are NOT accepted by the runtime.
export type HeartbeatRequestOptions = {
  reason: string;
  sessionKey: string;
  agentId: string;
};

// Best-effort extraction of human-readable detail (the actual question, error,
// or notification text) from a Claude Code hook payload so it can be forwarded
// to the watcher instead of just a generic "is waiting" line.
const DETAIL_FIELDS = [
  "message",
  "prompt",
  "question",
  "notification",
  "reason",
  "error",
  "summary",
] as const;

export function extractEventDetail(payload: ClaudeCodeHookPayload): string | undefined {
  for (const key of DETAIL_FIELDS) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 500);
    }
  }
  if (typeof payload.tool_name === "string" && payload.tool_name.trim()) {
    return `tool: ${payload.tool_name.trim()}`;
  }
  return undefined;
}

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

    const detail = extractEventDetail(state.lastHookPayload);
    const text =
      `${behavior.prefix} Claude Code session ${state.tmuxSession ?? state.sessionId} is ${behavior.message}` +
      (detail ? `: ${detail}` : "");
    let enqueued = false;
    try {
      enqueued = enqueueSystemEvent(text, {
        sessionKey,
        contextKey: `cron:claude-code:${state.sessionId}`,
      });
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

    const agentId = sessionKey.split(":")[1] ?? "";
    try {
      requestHeartbeat({
        reason: "claude-code-state-change",
        sessionKey,
        agentId,
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
