// Notification bridge: hook events → requester session system events.
//
// Uses the bash-bg / detached-task pattern:
//   enqueueSystemEvent(text, { contextKey: "task:claude-code:<id>" })
//   requestHeartbeatNow({ source: "background-task", intent: "immediate" })
//
// With "task:" prefix (NOT "cron:"), the event survives heartbeat-ownership
// and appears as a System: line in the requester's next user turn via
// drainFormattedSystemEvents. The heartbeat-runner does not claim it, and
// it is NOT suppressed by selectGenericSystemEvents (which only filters
// cron:-prefixed events when suppressHeartbeatOwnedEvents=true).

export type TaskRegistry = {
  createTask(params: { runId: string; task: string; label?: string }): void;
  onStateTransition(state: { sessionId: string; tmuxSession?: string; state: string; lastHookPayload: Record<string, unknown> }): void;
};

export type TaskRegistryDeps = {
  enqueueSystemEvent: (text: string, opts: { sessionKey: string; contextKey: string }) => boolean;
  requestHeartbeatNow: (opts: {
    source: string;
    intent: string;
    reason: string;
    sessionKey: string;
    agentId?: string;
  }) => void;
  requesterSessionKey: string;
  log?: (text: string) => void;
};

const NOTIFY_STATES = new Set(["WAITING", "QUESTION", "PERMISSION", "ERROR"]);
const TERMINAL_STATES = new Set(["DONE", "FATAL"]);

export function createTaskRegistry(deps: TaskRegistryDeps): TaskRegistry {
  const { enqueueSystemEvent, requestHeartbeatNow, requesterSessionKey, log } = deps;
  const agentId = requesterSessionKey.split(":")[1] ?? "";
  const seenStates = new Set<string>();

  function wake() {
    requestHeartbeatNow({
      source: "background-task" as const,
      intent: "immediate" as const,
      reason: "claude-code-state-change",
      sessionKey: requesterSessionKey,
      agentId,
    });
  }

  return {
    createTask() {
      // No persistent task record needed — the enqueue path handles delivery.
    },

    onStateTransition(state) {
      const label = state.tmuxSession ?? state.sessionId;
      const contextKey = `task:claude-code:${state.sessionId}`;
      log?.(`claude-code: notify state=${state.state} sessionId=${state.sessionId} contextKey=${contextKey}`);

      if (TERMINAL_STATES.has(state.state)) {
        const result = extractResultText(state.lastHookPayload);
        const text = `✅ Claude Code session \`${label}\` **${state.state === "FATAL" ? "timed out" : "finished"}**.` +
          (result ? `\n\n> ${result.slice(0, 500)}` : "");
        enqueueSystemEvent(text, { sessionKey: requesterSessionKey, contextKey });
        wake();
        return;
      }

      if (NOTIFY_STATES.has(state.state)) {
        const key = `${state.sessionId}:${state.state}`;
        if (seenStates.has(key)) return;
        seenStates.add(key);

        const text = `⚠️ Claude Code session \`${label}\` is **${state.state.toLowerCase()}** — needs attention.`;
        enqueueSystemEvent(text, { sessionKey: requesterSessionKey, contextKey });
        wake();
        return;
      }
    },
  };
}

function extractResultText(payload: Record<string, unknown>): string | undefined {
  const msg = payload.last_assistant_message;
  if (typeof msg === "string" && msg.trim()) return msg.trim();
  return undefined;
}
