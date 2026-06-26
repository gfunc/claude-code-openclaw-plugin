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

  function setup() {
    const enqueueSystemEvent = vi.fn(() => true);
    const requestHeartbeatNow = vi.fn();
    const log = vi.fn();
    const reg = createTaskRegistry({ enqueueSystemEvent, requestHeartbeatNow, requesterSessionKey, log });
    return { enqueueSystemEvent, requestHeartbeatNow, log, reg };
  }

  // ── notify states ──────────────────────────────────────────

  it.each(["WAITING", "QUESTION", "PERMISSION", "ERROR"])(
    "enqueues but does NOT wake on %s transition (intermediate states)",
    (state) => {
      const { enqueueSystemEvent, requestHeartbeatNow, reg } = setup();

      reg.onStateTransition(makeState({ state }));

      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("needs attention"),
        expect.objectContaining({
          sessionKey: requesterSessionKey,
          contextKey: "task:claude-code:sid-1",
        }),
      );
      expect(requestHeartbeatNow).not.toHaveBeenCalled();
    },
  );

  it("includes tmux session name in the event text", () => {
    const { enqueueSystemEvent, reg } = setup();

    reg.onStateTransition(makeState({ state: "WAITING", tmuxSession: "cc-my-task" }));

    expect(enqueueSystemEvent).toHaveBeenCalled();
    expect(enqueueSystemEvent.mock.calls[0]![0]).toContain("cc-my-task");
  });

  it("falls back to sessionId when tmuxSession is missing", () => {
    const { enqueueSystemEvent, reg } = setup();

    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    reg.onStateTransition(makeState({ state: "WAITING", tmuxSession: undefined }));

    expect(enqueueSystemEvent).toHaveBeenCalled();
    expect(enqueueSystemEvent.mock.calls[0]![0]).toContain("sid-1");
  });

  // ── terminal states ─────────────────────────────────────────

  it.each(["DONE", "FATAL"])(
    "enqueues and wakes with formatted text on %s",
    (state) => {
      const { enqueueSystemEvent, requestHeartbeatNow, reg } = setup();

      reg.onStateTransition(makeState({
        state,
        lastHookPayload: {
          hook_event_name: state === "DONE" ? "SessionEnd" : "Stop",
          session_id: "sid-1",
          last_assistant_message: "the result text",
        },
      }));

      expect(enqueueSystemEvent).toHaveBeenCalled();
      const call = enqueueSystemEvent.mock.calls[0]!;
      expect(call[0]).toContain("the result text");
      if (state === "FATAL") {
        expect(call[0]).toContain("timed out");
      } else {
        expect(call[0]).toContain("finished");
      }
      expect(call[1].contextKey).toBe("task:claude-code:sid-1");
      expect(requestHeartbeatNow).toHaveBeenCalled();
    },
  );

  it("omits result block when last_assistant_message is absent", () => {
    const { enqueueSystemEvent, reg } = setup();

    reg.onStateTransition(makeState({ state: "DONE" }));

    expect(enqueueSystemEvent).toHaveBeenCalled();
    const text = enqueueSystemEvent.mock.calls[0]![0] as string;
    expect(text).toContain("finished");
    expect(text).not.toContain(">");
  });

  // ── no-ops ──────────────────────────────────────────────────

  it("does not fire on WORKING transitions", () => {
    const { enqueueSystemEvent, reg } = setup();

    reg.onStateTransition(makeState({ state: "WORKING" }));

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("does not re-fire for same session+state twice", () => {
    const { enqueueSystemEvent, reg } = setup();

    reg.onStateTransition(makeState({ state: "WAITING" }));
    reg.onStateTransition(makeState({ state: "WAITING" }));

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
  });

  it("still fires for different sessions in same state", () => {
    const { enqueueSystemEvent, reg } = setup();

    reg.onStateTransition(makeState({ state: "WAITING", sessionId: "sid-a" }));
    reg.onStateTransition(makeState({ state: "WAITING", sessionId: "sid-b" }));

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(2);
  });

  // ── misc ────────────────────────────────────────────────────

  it("createTask is a no-op", () => {
    const { reg } = setup();
    expect(() => reg.createTask({ runId: "r1", task: "do stuff" })).not.toThrow();
  });

  it("logs on every transition", () => {
    const { log, reg } = setup();

    reg.onStateTransition(makeState({ state: "WAITING" }));

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("claude-code: notify state=WAITING"),
    );
  });

  it("wake fires with correct agentId derived from sessionKey", () => {
    const requestHeartbeatNow = vi.fn();
    const reg = createTaskRegistry({
      enqueueSystemEvent: vi.fn(() => true),
      requestHeartbeatNow,
      requesterSessionKey: "agent:cc-watcher:main",
    });

    reg.onStateTransition(makeState({ state: "DONE" }));

    expect(requestHeartbeatNow).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "cc-watcher" }),
    );
  });
});
