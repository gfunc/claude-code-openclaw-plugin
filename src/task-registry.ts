// Notification bridge: hook state transitions → caller's session via system events.
//
// Routing: each SessionState carries notifySessionKey + notifyDeliveryContext
// captured from the tool-factory ctx at spawn time (see index.ts). On state
// transitions we enqueue an exec-completion event addressed at that session
// (with channel hint) and request a wake heartbeat.
//
// Why exec-completion format for ALL notify states (not just DONE/FATAL):
//   heartbeat-runner only generates a user-visible prompt when
//   isExecCompletionEvent(text)===true — otherwise resolveHeartbeatRunPrompt
//   returns null and the agent stays silent. By emitting the same format for
//   WAITING/PERMISSION/etc. with code 0, the receiving LLM is prompted to
//   "relay this background task update" and naturally responds.
//
// See: docs/openclaw-background-task-notification.md §3.1, §3.4.

import type { DeliveryContext, SessionState } from "./state.js";

export type TaskRegistry = {
  onStateTransition(state: SessionState): void;
};

export type TaskRegistryDeps = {
  enqueueSystemEvent: (text: string, opts: {
    sessionKey: string;
    contextKey: string;
    deliveryContext?: DeliveryContext;
  }) => boolean;
  requestHeartbeatNow: (opts: {
    source: string;
    intent: string;
    reason: string;
    sessionKey: string;
    agentId?: string;
  }) => void;
  defaultNotifySessionKey: string;
  log?: (text: string) => void;
};

const NOTIFY_STATES = new Set(["WAITING", "QUESTION", "PERMISSION", "ERROR", "DONE", "FATAL"]);

type StateDescriptor = {
  verb: "completed" | "failed";
  exitCode: "code 0" | "code 1";
  emoji: string;
  mood: string;
};

function describeState(state: string): StateDescriptor {
  switch (state) {
    case "DONE":       return { verb: "completed", exitCode: "code 0", emoji: "🚨", mood: "finished" };
    case "FATAL":      return { verb: "failed",    exitCode: "code 1", emoji: "🚨", mood: "timed out" };
    case "WAITING":    return { verb: "completed", exitCode: "code 0", emoji: "⚠️", mood: "needs attention (waiting for input)" };
    case "QUESTION":   return { verb: "completed", exitCode: "code 0", emoji: "⚠️", mood: "needs attention (waiting for an answer)" };
    case "PERMISSION": return { verb: "completed", exitCode: "code 0", emoji: "⚠️", mood: "needs attention (waiting for permission)" };
    case "ERROR":      return { verb: "completed", exitCode: "code 0", emoji: "⚠️", mood: "needs attention (tool failed)" };
    default:           return { verb: "completed", exitCode: "code 0", emoji: "ℹ️", mood: state.toLowerCase() };
  }
}

export function createTaskRegistry(deps: TaskRegistryDeps): TaskRegistry {
  const { enqueueSystemEvent, requestHeartbeatNow, defaultNotifySessionKey, log } = deps;
  const seenStates = new Set<string>();

  return {
    onStateTransition(state) {
      if (!NOTIFY_STATES.has(state.state)) return;

      const key = `${state.sessionId}:${state.state}`;
      if (seenStates.has(key)) return;
      seenStates.add(key);

      const target = state.notifySessionKey ?? defaultNotifySessionKey;
      const agentId = target.split(":")[1] ?? "";
      const label = state.tmuxSession ?? state.sessionId;
      const contextKey = `task:claude-code:${state.sessionId}`;
      const reason = `claude-code:${state.sessionId}:${state.state}`;

      const { verb, exitCode, emoji, mood } = describeState(state.state);
      const result = extractResultText(state.lastHookPayload as Record<string, unknown>);
      const resultSuffix = result ? `\n> ${result.slice(0, 7000)}` : "";
      const execId = state.sessionId.replace(/[^a-z0-9_-]/gi, "-").slice(0, 64);
      const body = `${emoji} Claude Code session \`${label}\` **${mood}**.${resultSuffix}`;
      const text = `exec ${verb} (claude-code-${execId}, ${exitCode}) :: ${body}`;

      log?.(`claude-code: notify state=${state.state} sessionId=${state.sessionId} target=${target} contextKey=${contextKey}`);

      const enqOpts: { sessionKey: string; contextKey: string; deliveryContext?: DeliveryContext } = {
        sessionKey: target,
        contextKey,
      };
      if (state.notifyDeliveryContext) enqOpts.deliveryContext = state.notifyDeliveryContext;

      enqueueSystemEvent(text, enqOpts);
      requestHeartbeatNow({
        source: "hook",
        intent: "immediate",
        reason,
        sessionKey: target,
        agentId,
      });
    },
  };
}

function extractResultText(payload: Record<string, unknown>): string | undefined {
  const msg = payload.last_assistant_message;
  if (typeof msg === "string" && msg.trim()) return msg.trim();
  return undefined;
}
