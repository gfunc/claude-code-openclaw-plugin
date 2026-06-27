// Notification bridge: hook events → requester session system events.
//
// Uses the SAME exec-completion event format as OpenClaw's own bash-bg /
// detached-task pattern:
//
//   enqueueSystemEvent(
//     "exec completed (claude-code-<id>, code 0) :: <message>",
//     { contextKey: "task:claude-code:<id>" }
//   )
//   requestHeartbeatNow({ source: "hook", intent: "immediate" })
//
// Why this works:
// 1. The text matches STRUCTURED_EXEC_COMPLETION_EVENT_RE → isExecCompletionEvent=true
// 2. Wake heartbeats (isWakePayload=true, source="hook") inspect pending events →
//    hasExecCompletion=true → buildExecEventPrompt() generates a prompt like
//    "An async command you ran earlier has completed. Please relay..."
// 3. The heartbeat runner dispatches this prompt → agent generates user-visible reply
// 4. Interval heartbeats (isWakePayload=false) skip event inspection entirely
//    because shouldInspectPendingEvents=false (all four flags are false with
//    task: prefix + non-wake source) → events survive until the wake processes them
//
// contextKey uses "task:" prefix so hasTaggedCronEvents stays false, preventing
// interval heartbeats from inspecting/consuming events.
//
// source MUST be "hook" — the runner only treats source="hook"/"acp-spawn" or
// reason="wake" as isWakePayload=true (required for event inspection + prompt gen).

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
  onTerminalState?: (params: {
    sessionId: string;
    label: string;
    state: string;
    text: string;
  }) => void;
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

      // Terminal states → enqueue as exec-completion event + wake immediately.
      // The exec format is recognized by the heartbeat runner as a background
      // task completion, which generates a prompt and user-visible reply.
      if (TERMINAL_STATES.has(state.state)) {
        const result = extractResultText(state.lastHookPayload);
        const resultSuffix = result ? `\n> ${result.slice(0, 7000)}` : "";
        const execId = state.sessionId.replace(/[^a-z0-9_-]/gi, "-").slice(0, 64);
        const verb = state.state === "FATAL" ? "failed" : "completed";
        const exitCode = state.state === "FATAL" ? "code 1" : "code 0";
        const body = `🚨 Claude Code session \`${label}\` **${state.state === "FATAL" ? "timed out" : "finished"}**.${resultSuffix}`;
        const text = `exec ${verb} (claude-code-${execId}, ${exitCode}) :: ${body}`;
        const ok = enqueueSystemEvent(text, { sessionKey: requesterSessionKey, contextKey });
        log?.(`claude-code: enqueue terminal ok=${ok} sessionId=${state.sessionId} state=${state.state} contextKey=${contextKey} sessionKey=${requesterSessionKey}`);
        deps.onTerminalState?.({
          sessionId: state.sessionId,
          label,
          state: state.state,
          text: body,
        });
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
