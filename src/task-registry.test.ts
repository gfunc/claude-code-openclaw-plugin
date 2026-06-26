import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ClaudeCodeHookPayload, SessionState } from "./state.js";

vi.mock("openclaw/plugin-sdk/agent-harness-task-runtime", () => ({
  createAgentHarnessTaskRuntime: vi.fn(() => ({
    createRunningTaskRun: vi.fn(() => ({ runId: "test-run", taskId: "task-1" })),
    recordTaskRunProgressByRunId: vi.fn(() => [{ runId: "test-run" }]),
    finalizeTaskRunByRunId: vi.fn(() => [{ runId: "test-run" }]),
  })),
  deliverAgentHarnessTaskCompletion: vi.fn(() =>
    Promise.resolve({ delivered: true, path: "direct" }),
  ),
}));

import { createTaskRegistry } from "./task-registry.js";
import {
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";

type MockHarness = {
  createRunningTaskRun: ReturnType<typeof vi.fn>;
  recordTaskRunProgressByRunId: ReturnType<typeof vi.fn>;
  finalizeTaskRunByRunId: ReturnType<typeof vi.fn>;
};

function getHarness(): MockHarness {
  return vi.mocked(createAgentHarnessTaskRuntime).mock
    .results[0].value as MockHarness;
}

function makeState(
  overrides: Record<string, unknown> & { sessionId: string; state: string },
): SessionState {
  return {
    tmuxSession: "test-tmux",
    lastHookEvent: "Stop",
    lastHookPayload: {
      hook_event_name: "Stop",
      session_id: overrides.sessionId,
    } as ClaudeCodeHookPayload,
    stateSince: Date.now(),
    lastSeenAt: Date.now(),
    history: [],
    ...overrides,
  } as unknown as SessionState;
}

describe("createTaskRegistry", () => {
  let registry: ReturnType<typeof createTaskRegistry>;
  let harness: MockHarness;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = createTaskRegistry({ requesterSessionKey: "test-key" });
    harness = getHarness();
  });

  it("createTask calls harness and returns record", () => {
    const result = registry.createTask({
      runId: "run-1",
      task: "test task",
      label: "my-label",
    });

    expect(harness.createRunningTaskRun).toHaveBeenCalledWith({
      runId: "run-1",
      task: "test task",
      label: "my-label",
      notifyPolicy: "state_changes",
    });
    expect(result).toEqual({ runId: "test-run", taskId: "task-1" });
  });

  it("onStateTransition with WAITING state fires progress", () => {
    registry.createTask({ runId: "run-1", task: "test task", label: "my-label" });

    const state = makeState({
      sessionId: "sess-1",
      state: "WAITING",
      runId: "run-1",
      requesterSessionKey: "test-key",
    });
    registry.onStateTransition(state, "WORKING");

    expect(harness.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: "run-1",
      eventSummary: "session my-label is WAITING",
    });
  });

  it("onStateTransition with WORKING state does NOT fire progress", () => {
    registry.createTask({ runId: "run-1", task: "test task", label: "my-label" });

    const state = makeState({
      sessionId: "sess-2",
      state: "WORKING",
      runId: "run-1",
      requesterSessionKey: "test-key",
    });
    registry.onStateTransition(state, "WAITING");

    expect(harness.recordTaskRunProgressByRunId).not.toHaveBeenCalled();
  });

  it("onStateTransition with WAITING state that was already seen does NOT re-fire", () => {
    registry.createTask({ runId: "run-1", task: "test task", label: "my-label" });

    const state = makeState({
      sessionId: "sess-3",
      state: "WAITING",
      runId: "run-1",
      requesterSessionKey: "test-key",
    });

    registry.onStateTransition(state, "WORKING");
    expect(harness.recordTaskRunProgressByRunId).toHaveBeenCalledTimes(1);

    registry.onStateTransition(state, "WORKING");
    expect(harness.recordTaskRunProgressByRunId).toHaveBeenCalledTimes(1);
  });

  it("onStateTransition with DONE state calls finalize AND deliverCompletion", () => {
    registry.createTask({ runId: "run-1", task: "test task", label: "my-label" });

    const state = makeState({
      sessionId: "sess-4",
      state: "DONE",
      runId: "run-1",
      requesterSessionKey: "test-key",
      stateSince: 1_000_000,
      lastHookPayload: {
        hook_event_name: "SessionEnd",
        session_id: "sess-4",
      },
    });
    registry.onStateTransition(state, "WORKING");

    expect(harness.finalizeTaskRunByRunId).toHaveBeenCalledWith({
      runId: "run-1",
      endedAt: 1_000_000,
      status: "succeeded",
      terminalSummary: "No output",
    });

    expect(deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith({
      scope: { requesterSessionKey: "test-key" },
      childSessionKey: "claude-code:sess-4",
      childSessionId: "sess-4",
      announceId: "claude-code:sess-4:done",
      status: "succeeded",
      statusLabel: "Succeeded",
      result: "No output",
      taskLabel: "my-label",
      announceType: "Claude Code session",
    });
  });
});
