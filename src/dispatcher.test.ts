import { describe, expect, it, vi } from "vitest";
import { createBehaviorDispatcher } from "./dispatcher.js";
import type { SessionState } from "./state.js";

function makeSession(state: SessionState["state"], sessionId: string): SessionState {
  return {
    sessionId,
    tmuxSession: "cc-test",
    state,
    lastHookEvent: "SessionStart",
    lastHookPayload: { hook_event_name: "SessionStart", session_id: sessionId },
    stateSince: Date.now(),
    lastSeenAt: Date.now(),
    history: [],
  };
}

describe("createBehaviorDispatcher", () => {
  it("enqueues system event for WAITING", () => {
    const enqueueSystemEvent = vi.fn(() => true);
    const dispatcher = createBehaviorDispatcher({
      enqueueSystemEvent,
      notifyStates: ["WAITING"],
      sessionKey: "agent:main:main",
    });
    dispatcher.onStateChanged(makeSession("WAITING", "s1"));
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("waiting for input"),
      { sessionKey: "agent:main:main", contextKey: "s1" },
    );
  });

  it("does not enqueue for WORKING", () => {
    const enqueueSystemEvent = vi.fn(() => true);
    const dispatcher = createBehaviorDispatcher({
      enqueueSystemEvent,
      notifyStates: ["WAITING", "WORKING"],
      sessionKey: "agent:main:main",
    });
    dispatcher.onStateChanged(makeSession("WORKING", "s2"));
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("only announces FATAL once", () => {
    const enqueueSystemEvent = vi.fn(() => true);
    const dispatcher = createBehaviorDispatcher({
      enqueueSystemEvent,
      notifyStates: ["FATAL"],
      sessionKey: "agent:main:main",
    });
    dispatcher.onStateChanged(makeSession("FATAL", "s5"));
    dispatcher.onStateChanged(makeSession("FATAL", "s5"));
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
  });

  it("honors notifyStates override", () => {
    const enqueueSystemEvent = vi.fn(() => true);
    const dispatcher = createBehaviorDispatcher({
      enqueueSystemEvent,
      notifyStates: ["WAITING"],
      sessionKey: "agent:main:main",
    });
    dispatcher.onStateChanged(makeSession("DONE", "s6"));
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });
});
