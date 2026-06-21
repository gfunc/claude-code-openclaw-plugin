import { resolveBehavior } from "./behavior.js";
import type { ClaudeCodeState } from "./config.js";
import type { SessionState } from "./state.js";

export type BehaviorDispatcher = {
  onStateChanged(state: SessionState): void;
  getPendingAnnounceSessionIds(): string[];
};

export function createBehaviorDispatcher(options: {
  enqueueSystemEvent: (text: string, opts: { sessionKey: string; contextKey: string }) => boolean;
  notifyStates: ClaudeCodeState[];
  sessionKey: string;
}): BehaviorDispatcher {
  const { enqueueSystemEvent, notifyStates, sessionKey } = options;
  const announcedOnce = new Set<string>();

  function onStateChanged(state: SessionState): void {
    const behavior = resolveBehavior(state.state, notifyStates);
    if (!behavior.announce) return;
    if (behavior.oneShotAnnounce && announcedOnce.has(state.sessionId)) return;
    if (behavior.oneShotAnnounce) announcedOnce.add(state.sessionId);

    const text = `${behavior.prefix} Claude Code session ${state.tmuxSession ?? state.sessionId} is ${behavior.message}`;
    try {
      enqueueSystemEvent(text, { sessionKey, contextKey: state.sessionId });
    } catch (err) {
      // Best-effort: don't let notification failures break hook processing.
      // eslint-disable-next-line no-console
      console.error("claude-code: enqueueSystemEvent failed:", err);
    }
  }

  function getPendingAnnounceSessionIds(): string[] {
    return [];
  }

  return { onStateChanged, getPendingAnnounceSessionIds };
}
