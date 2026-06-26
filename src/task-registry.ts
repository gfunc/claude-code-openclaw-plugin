import {
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import type { AgentHarnessTaskRuntime } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import type { SessionState, ClaudeCodeHookPayload } from "./state.js";

const NOTIFY_STATES = new Set(["WAITING", "QUESTION", "PERMISSION", "ERROR"]);

export type TaskRegistry = {
  createTask(params: {
    runId: string;
    task: string;
    label?: string;
  }): ReturnType<AgentHarnessTaskRuntime["createRunningTaskRun"]>;
  onStateTransition(state: SessionState, prevState: string): void;
};

export function createTaskRegistry(opts: {
  requesterSessionKey: string;
  harness?: AgentHarnessTaskRuntime;
}): TaskRegistry {
  const { requesterSessionKey } = opts;

  let harness: AgentHarnessTaskRuntime;
  try {
    harness =
      opts.harness ??
      createAgentHarnessTaskRuntime({
        runtime: "cli",
        scope: { requesterSessionKey },
        taskKind: "claude-code",
        runIdPrefix: "",
      });
  } catch {
    // No OpenClaw runtime available (e.g. unit tests). Return a no-op
    // registry so callers don't crash.
    return {
      createTask: () => ({ runId: "", taskId: "" }) as ReturnType<AgentHarnessTaskRuntime["createRunningTaskRun"]>,
      onStateTransition: () => {},
    };
  }

  const scope = { requesterSessionKey };
  const seenStates = new Set<string>();
  const taskLabels = new Map<string, string>();

  return {
    createTask(params: { runId: string; task: string; label?: string }) {
      const label = params.label ?? params.runId;
      taskLabels.set(params.runId, label);
      return harness.createRunningTaskRun({
        runId: params.runId,
        task: params.task,
        label,
        notifyPolicy: "state_changes",
      });
    },

    onStateTransition(state: SessionState, _prevState: string): void {
      if (!state.runId || !state.requesterSessionKey) return;

      const runId = state.runId;
      const label = taskLabels.get(runId) ?? runId;

      if (state.state === "DONE" || state.state === "FATAL") {
        const terminalSummary = extractResultText(state.lastHookPayload) ?? "No output";
        const status = state.state === "FATAL" ? "timed_out" : "succeeded";

        harness.finalizeTaskRunByRunId({
          runId,
          endedAt: state.stateSince,
          status,
          terminalSummary,
        });

        deliverAgentHarnessTaskCompletion({
          scope,
          childSessionKey: `claude-code:${state.sessionId}`,
          childSessionId: state.sessionId,
          announceId: `claude-code:${state.sessionId}:${state.state.toLowerCase()}`,
          status: state.state === "FATAL" ? "failed" : "succeeded",
          statusLabel: state.state === "FATAL" ? "Failed" : "Succeeded",
          result: terminalSummary,
          taskLabel: label,
          announceType: "Claude Code session",
        }).catch(() => {
          // fire-and-forget: rejections are non-fatal
        });
        return;
      }

      if (NOTIFY_STATES.has(state.state)) {
        const key = `${state.sessionId}:${state.state}`;
        if (seenStates.has(key)) return;
        seenStates.add(key);
        harness.recordTaskRunProgressByRunId({
          runId,
          eventSummary: `session ${label} is ${state.state}`,
        });
        return;
      }

      // Non-notify states (WORKING): no-op
    },
  };
}

export function extractResultText(payload: ClaudeCodeHookPayload): string | undefined {
  const text = payload.last_assistant_message;
  if (typeof text === "string" && text.length > 0) {
    return text.slice(0, 2000);
  }
  return undefined;
}
