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
      { sessionKey: "agent:main:main", contextKey: "cron:claude-code:s1" },
    );
  });

  it("includes the question/detail text from the hook payload", () => {
    const enqueueSystemEvent = vi.fn(() => true);
    const dispatcher = createBehaviorDispatcher({
      enqueueSystemEvent,
      notifyStates: ["QUESTION"],
      sessionKey: "agent:main:main",
    });
    const session = makeSession("QUESTION", "sq");
    session.lastHookPayload = {
      hook_event_name: "Elicitation",
      session_id: "sq",
      message: "Which database should I use?",
    };
    dispatcher.onStateChanged(session);
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("Which database should I use?"),
      { sessionKey: "agent:main:main", contextKey: "cron:claude-code:sq" },
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

  it("requests immediate heartbeat after enqueuing a state-change event", () => {
    const enqueueSystemEvent = vi.fn(() => true);
    const requestHeartbeat = vi.fn();
    const dispatcher = createBehaviorDispatcher({
      enqueueSystemEvent,
      requestHeartbeat,
      notifyStates: ["DONE"],
      sessionKey: "agent:cc-watcher:main",
    });
    dispatcher.onStateChanged(makeSession("DONE", "s7"));
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(requestHeartbeat).toHaveBeenCalledWith({
      reason: "claude-code-state-change",
      sessionKey: "agent:cc-watcher:main",
      agentId: "cc-watcher",
    });
  });

  it("throttles heartbeat requests within 1 second for the same session", () => {
    const enqueueSystemEvent = vi.fn(() => true);
    const requestHeartbeat = vi.fn();
    const dispatcher = createBehaviorDispatcher({
      enqueueSystemEvent,
      requestHeartbeat,
      notifyStates: ["DONE"],
      sessionKey: "agent:cc-watcher:main",
    });
    const state = makeSession("DONE", "s8");
    dispatcher.onStateChanged(state);
    dispatcher.onStateChanged(state);
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(2);
    expect(requestHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("does not request heartbeat when enqueueSystemEvent returns false", () => {
    const enqueueSystemEvent = vi.fn(() => false);
    const requestHeartbeat = vi.fn();
    const dispatcher = createBehaviorDispatcher({
      enqueueSystemEvent,
      requestHeartbeat,
      notifyStates: ["DONE"],
      sessionKey: "agent:cc-watcher:main",
    });
    dispatcher.onStateChanged(makeSession("DONE", "s9"));
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("does not request heartbeat when requestHeartbeat is not provided", () => {
    const enqueueSystemEvent = vi.fn(() => true);
    const dispatcher = createBehaviorDispatcher({
      enqueueSystemEvent,
      notifyStates: ["DONE"],
      sessionKey: "agent:cc-watcher:main",
    });
    dispatcher.onStateChanged(makeSession("DONE", "s10"));
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
  });
});
