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
  it("wakes heartbeat for WAITING", () => {
    const requestHeartbeat = vi.fn();
    const dispatcher = createBehaviorDispatcher({ requestHeartbeat, notifyStates: ["WAITING"] });
    dispatcher.onStateChanged(makeSession("WAITING", "s1"));
    expect(requestHeartbeat).toHaveBeenCalledWith({ reason: "claude-code:waiting" });
  });

  it("does not wake for WORKING", () => {
    const requestHeartbeat = vi.fn();
    const dispatcher = createBehaviorDispatcher({
      requestHeartbeat,
      notifyStates: ["WAITING", "WORKING"],
    });
    dispatcher.onStateChanged(makeSession("WORKING", "s2"));
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("does not wake for FATAL", () => {
    const requestHeartbeat = vi.fn();
    const dispatcher = createBehaviorDispatcher({ requestHeartbeat, notifyStates: ["FATAL"] });
    dispatcher.onStateChanged(makeSession("FATAL", "s3"));
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("tracks pending announce and flushes it with sessionKey", () => {
    const requestHeartbeat = vi.fn();
    const enqueueSystemEvent = vi.fn();
    const dispatcher = createBehaviorDispatcher({
      requestHeartbeat,
      enqueueSystemEvent,
      notifyStates: ["WAITING"],
    });
    dispatcher.onStateChanged(makeSession("WAITING", "s4"));
    expect(dispatcher.getPendingAnnounceSessionIds()).toEqual(["s4"]);
    const flushed = dispatcher.flushAnnouncements("sk-1");
    expect(flushed).toHaveLength(1);
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("waiting for input"),
      { sessionKey: "sk-1" },
    );
  });

  it("only announces FATAL once", () => {
    const requestHeartbeat = vi.fn();
    const enqueueSystemEvent = vi.fn();
    const dispatcher = createBehaviorDispatcher({
      requestHeartbeat,
      enqueueSystemEvent,
      notifyStates: ["FATAL"],
    });
    dispatcher.onStateChanged(makeSession("FATAL", "s5"));
    dispatcher.flushAnnouncements("sk-2");
    dispatcher.onStateChanged(makeSession("FATAL", "s5"));
    const flushed = dispatcher.flushAnnouncements("sk-2");
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(flushed).toHaveLength(0);
  });

  it("honors notifyStates override", () => {
    const requestHeartbeat = vi.fn();
    const dispatcher = createBehaviorDispatcher({
      requestHeartbeat,
      notifyStates: ["WAITING"],
    });
    dispatcher.onStateChanged(makeSession("DONE", "s6"));
    expect(requestHeartbeat).not.toHaveBeenCalled();
    expect(dispatcher.getPendingAnnounceSessionIds()).toEqual([]);
  });
});
