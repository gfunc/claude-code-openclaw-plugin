// Notification bridge: hook events → requester session system events.
//
// Uses the bash-bg / detached-task pattern:
//   enqueueSystemEvent(text, { contextKey: "task:claude-code:<id>" })
//   requestHeartbeatNow({ source: "hook", intent: "immediate" })
//
// source MUST be "hook" (not "background-task") — the OpenClaw heartbeat
// runner only treats source="hook"/"acp-spawn" or reason="wake" as a wake
// payload (isWakePayload=true).  Without isWakePayload the runner returns
// "skipped: no-tasks-due" and silently consumes pending system events
// without generating a user-visible reply.

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

  function wake(reason: string) {
    log?.(`claude-code: wake reason=${reason} sessionKey=${requesterSessionKey} agentId=${agentId}`);
    requestHeartbeatNow({
      source: "hook" as const,
      intent: "immediate" as const,
      reason,
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
      const reason = `claude-code:${state.sessionId}:${state.state}`;
      log?.(`claude-code: notify state=${state.state} sessionId=${state.sessionId} contextKey=${contextKey}`);

      // Terminal states → enqueue event + wake immediately.
      // These are the ONLY states that trigger a wake: every wake now means
      // "a session completed — report results to the user now."
      if (TERMINAL_STATES.has(state.state)) {
        const result = extractResultText(state.lastHookPayload);
        const resultSuffix = result ? `\n\n> ${result.slice(0, 500)}` : "";
        const text = `🚨 Claude Code session \`${label}\` **${state.state === "FATAL" ? "timed out" : "finished"}**. Report this to the user now.${resultSuffix}`;
        const ok = enqueueSystemEvent(text, { sessionKey: requesterSessionKey, contextKey });
        log?.(`claude-code: enqueue terminal ok=${ok} sessionId=${state.sessionId} state=${state.state} contextKey=${contextKey} sessionKey=${requesterSessionKey}`);
        wake(reason);
        return;
      }

      // Intermediate states → enqueue event only, no wake.
      // The agent will drain these during its next natural heartbeat cycle.
      if (NOTIFY_STATES.has(state.state)) {
        const key = `${state.sessionId}:${state.state}`;
        if (seenStates.has(key)) return;
        seenStates.add(key);

        const text = `⚠️ Claude Code session \`${label}\` is **${state.state.toLowerCase()}** — needs attention.`;
        const ok = enqueueSystemEvent(text, { sessionKey: requesterSessionKey, contextKey });
        log?.(`claude-code: enqueue notify ok=${ok} sessionId=${state.sessionId} state=${state.state} contextKey=${contextKey}`);
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
