// @ts-nocheck — vitest mock.calls typing doesn't narrow after toHaveBeenCalled()
import { describe, expect, it, vi } from "vitest";
import { createTaskRegistry } from "./task-registry.js";

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "sid-1",
    tmuxSession: "cc-test",
    state: "WAITING",
    lastHookPayload: { hook_event_name: "Stop", session_id: "sid-1" },
    ...overrides,
  };
}

describe("createTaskRegistry", () => {
  const requesterSessionKey = "agent:main:main";

  it("enqueues and wakes on WAITING transition", () => {
    const enqueueSystemEvent = vi.fn(() => true);
    const requestHeartbeatNow = vi.fn();
    const reg = createTaskRegistry({ enqueueSystemEvent, requestHeartbeatNow, requesterSessionKey });

    reg.onStateTransition(makeState({ state: "WAITING" }));

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("needs attention"),
      expect.objectContaining({
        sessionKey: requesterSessionKey,
        contextKey: "task:claude-code:sid-1",
      }),
    );
    expect(requestHeartbeatNow).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "background-task",
        intent: "immediate",
        sessionKey: requesterSessionKey,
      }),
    );
  });

  it("does not fire on WORKING transitions", () => {
    const enqueueSystemEvent = vi.fn(() => true);
    const requestHeartbeatNow = vi.fn();
    const reg = createTaskRegistry({ enqueueSystemEvent, requestHeartbeatNow, requesterSessionKey });

    reg.onStateTransition(makeState({ state: "WORKING" }));

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("does not re-fire for same state twice", () => {
    const enqueueSystemEvent = vi.fn(() => true);
    const requestHeartbeatNow = vi.fn();
    const reg = createTaskRegistry({ enqueueSystemEvent, requestHeartbeatNow, requesterSessionKey });

    reg.onStateTransition(makeState({ state: "WAITING" }));
    reg.onStateTransition(makeState({ state: "WAITING" }));

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
  });

  it("fires terminal event with result text for DONE", () => {
    const enqueueSystemEvent = vi.fn(() => true);
    const requestHeartbeatNow = vi.fn();
    const reg = createTaskRegistry({ enqueueSystemEvent, requestHeartbeatNow, requesterSessionKey });

    reg.onStateTransition(makeState({
      state: "DONE",
      lastHookPayload: {
        hook_event_name: "SessionEnd",
        session_id: "sid-1",
        last_assistant_message: "all done here",
      },
    }));

    expect(enqueueSystemEvent).toHaveBeenCalled();
    const call = enqueueSystemEvent.mock.calls[0]!;
    expect(call[0]).toContain("finished");
    expect(call[0]).toContain("all done here");
    expect((call[1] as { contextKey: string }).contextKey).toBe("task:claude-code:sid-1");
    expect(requestHeartbeatNow).toHaveBeenCalled();
  });

  it("createTask is a no-op", () => {
    const reg = createTaskRegistry({
      enqueueSystemEvent: vi.fn(() => true),
      requestHeartbeatNow: vi.fn(),
      requesterSessionKey,
    });
    expect(() => reg.createTask({ runId: "r1", task: "do stuff" })).not.toThrow();
  });
});
