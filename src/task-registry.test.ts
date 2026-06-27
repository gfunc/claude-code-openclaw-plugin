// @ts-nocheck — vitest mock.calls typing doesn't narrow after toHaveBeenCalled()
import { describe, expect, it, vi } from "vitest";
import { createTaskRegistry } from "./task-registry.js";

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "sid-1",
    tmuxSession: "cc-test",
    state: "WAITING",
    lastHookEvent: "Stop",
    lastHookPayload: { hook_event_name: "Stop", session_id: "sid-1" },
    stateSince: 0,
    lastSeenAt: 0,
    history: [],
    ...overrides,
  };
}

describe("createTaskRegistry", () => {
  const defaultNotifySessionKey = "agent:main:main";

  function setup() {
    const enqueueSystemEvent = vi.fn(() => true);
    const requestHeartbeatNow = vi.fn();
    const log = vi.fn();
    const reg = createTaskRegistry({
      enqueueSystemEvent, requestHeartbeatNow, defaultNotifySessionKey, log,
    });
    return { enqueueSystemEvent, requestHeartbeatNow, log, reg };
  }

  describe("routing", () => {
    it("uses state.notifySessionKey when set", () => {
      const { enqueueSystemEvent, requestHeartbeatNow, reg } = setup();
      reg.onStateTransition(makeState({
        state: "DONE",
        notifySessionKey: "agent:wecom:user-1",
      }));
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ sessionKey: "agent:wecom:user-1" }),
      );
      expect(requestHeartbeatNow).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: "agent:wecom:user-1", agentId: "wecom" }),
      );
    });

    it("falls back to defaultNotifySessionKey when state.notifySessionKey is missing", () => {
      const { enqueueSystemEvent, requestHeartbeatNow, reg } = setup();
      reg.onStateTransition(makeState({ state: "DONE" }));
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ sessionKey: defaultNotifySessionKey }),
      );
      expect(requestHeartbeatNow).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: defaultNotifySessionKey, agentId: "main" }),
      );
    });

    it("passes deliveryContext through to enqueueSystemEvent", () => {
      const { enqueueSystemEvent, reg } = setup();
      reg.onStateTransition(makeState({
        state: "DONE",
        notifySessionKey: "agent:wecom:user-1",
        notifyDeliveryContext: { channel: "wecom", to: "user-1", accountId: "ww1" },
      }));
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          deliveryContext: { channel: "wecom", to: "user-1", accountId: "ww1" },
        }),
      );
    });

    it("omits deliveryContext when undefined", () => {
      const { enqueueSystemEvent, reg } = setup();
      reg.onStateTransition(makeState({ state: "DONE" }));
      const call = enqueueSystemEvent.mock.calls[0]!;
      expect(call[1].deliveryContext).toBeUndefined();
    });
  });

  describe("exec-completion format", () => {
    it.each([
      ["WAITING",    "completed", "code 0"],
      ["QUESTION",   "completed", "code 0"],
      ["PERMISSION", "completed", "code 0"],
      ["ERROR",      "completed", "code 0"],
      ["DONE",       "completed", "code 0"],
      ["FATAL",      "failed",    "code 1"],
    ])("emits 'exec %s (claude-code-<id>, %s)' for %s", (state, verb, exitCode) => {
      const { enqueueSystemEvent, reg } = setup();
      reg.onStateTransition(makeState({ state }));
      const text = enqueueSystemEvent.mock.calls[0]![0] as string;
      expect(text).toMatch(new RegExp(`^exec ${verb} \\(claude-code-[a-zA-Z0-9_-]+, ${exitCode}\\) :: `));
    });

    it("wakes on every notify state", () => {
      for (const state of ["WAITING", "QUESTION", "PERMISSION", "ERROR", "DONE", "FATAL"]) {
        const { requestHeartbeatNow, reg } = setup();
        reg.onStateTransition(makeState({ state, sessionId: `sid-${state}` }));
        expect(requestHeartbeatNow).toHaveBeenCalledTimes(1);
      }
    });

    it("includes last_assistant_message in result block when present", () => {
      const { enqueueSystemEvent, reg } = setup();
      reg.onStateTransition(makeState({
        state: "DONE",
        lastHookPayload: {
          hook_event_name: "SessionEnd",
          session_id: "sid-1",
          last_assistant_message: "the result text",
        },
      }));
      expect(enqueueSystemEvent.mock.calls[0]![0]).toContain("the result text");
    });

    it("omits result block when last_assistant_message is absent", () => {
      const { enqueueSystemEvent, reg } = setup();
      reg.onStateTransition(makeState({ state: "DONE" }));
      expect(enqueueSystemEvent.mock.calls[0]![0]).not.toContain("\n> ");
    });

    it("uses tmuxSession as label when present", () => {
      const { enqueueSystemEvent, reg } = setup();
      reg.onStateTransition(makeState({ state: "DONE", tmuxSession: "cc-my-task" }));
      expect(enqueueSystemEvent.mock.calls[0]![0]).toContain("cc-my-task");
    });

    it("falls back to sessionId as label when tmuxSession is missing", () => {
      const { enqueueSystemEvent, reg } = setup();
      reg.onStateTransition(makeState({ state: "WAITING", tmuxSession: undefined }));
      expect(enqueueSystemEvent.mock.calls[0]![0]).toContain("sid-1");
    });
  });

  describe("dedup", () => {
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

    it("still fires when same session moves to a different notify state", () => {
      const { enqueueSystemEvent, reg } = setup();
      reg.onStateTransition(makeState({ state: "WAITING" }));
      reg.onStateTransition(makeState({ state: "DONE" }));
      expect(enqueueSystemEvent).toHaveBeenCalledTimes(2);
    });
  });

  describe("no-ops", () => {
    it("does not fire on WORKING transitions", () => {
      const { enqueueSystemEvent, requestHeartbeatNow, reg } = setup();
      reg.onStateTransition(makeState({ state: "WORKING" }));
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(requestHeartbeatNow).not.toHaveBeenCalled();
    });

    it("createTask is a no-op", () => {
      const { reg } = setup();
      expect(() => reg.createTask({ runId: "r1", task: "do stuff" })).not.toThrow();
    });
  });

  describe("logging", () => {
    it("logs on every notify transition", () => {
      const { log, reg } = setup();
      reg.onStateTransition(makeState({ state: "WAITING" }));
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("claude-code: notify state=WAITING"),
      );
    });
  });
});
