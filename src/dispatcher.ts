import { resolveBehavior } from "./behavior.js";
import type { ClaudeCodeState } from "./config.js";
import type { SessionState } from "./state.js";

export type BehaviorDispatcher = {
  onStateChanged(state: SessionState): void;
  flushAnnouncements(sessionKey: string): Array<{ text: string; enqueued: boolean }>;
  getPendingAnnounceSessionIds(): string[];
};

export function createBehaviorDispatcher(options: {
  requestHeartbeat: (opts?: { reason?: string }) => void;
  enqueueSystemEvent?: (text: string, opts: { sessionKey: string }) => void;
  notifyStates: ClaudeCodeState[];
}): BehaviorDispatcher {
  const { requestHeartbeat, enqueueSystemEvent, notifyStates } = options;
  const pendingAnnounce = new Map<string, string>();
  const announcedOnce = new Set<string>();

  function onStateChanged(state: SessionState): void {
    const behavior = resolveBehavior(state.state, notifyStates);
    if (behavior.wake) {
      requestHeartbeat({ reason: `claude-code:${state.state.toLowerCase()}` });
    }
    if (behavior.announce) {
      if (behavior.oneShotAnnounce) {
        if (announcedOnce.has(state.sessionId)) return;
        announcedOnce.add(state.sessionId);
      }
      const text = `${behavior.prefix} Claude Code session ${state.tmuxSession ?? state.sessionId} is ${behavior.message}`;
      pendingAnnounce.set(state.sessionId, text);
    }
  }

  function flushAnnouncements(sessionKey: string): Array<{ text: string; enqueued: boolean }> {
    const results: Array<{ text: string; enqueued: boolean }> = [];
    for (const [sessionId, text] of pendingAnnounce) {
      const enqueued = Boolean(enqueueSystemEvent);
      if (enqueueSystemEvent) {
        enqueueSystemEvent(text, { sessionKey });
      }
      results.push({ text, enqueued });
      pendingAnnounce.delete(sessionId);
    }
    return results;
  }

  function getPendingAnnounceSessionIds(): string[] {
    return Array.from(pendingAnnounce.keys());
  }

  return { onStateChanged, flushAnnouncements, getPendingAnnounceSessionIds };
}
