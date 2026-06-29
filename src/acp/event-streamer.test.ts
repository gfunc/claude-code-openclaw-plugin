import { describe, it, expect, vi } from "vitest";
import { createAcpEventStreamer } from "./event-streamer.js";
import type { SessionStore } from "../store.js";
import type { SessionState } from "../state.js";

function createMockStore(states: SessionState[] = []): SessionStore {
  return {
    listStates: vi.fn(() => states),
    applyHook: vi.fn(),
    markFatal: vi.fn(),
    getState: vi.fn(),
    loadFromDisk: vi.fn(),
    dispose: vi.fn(),
    setNotifyContext: vi.fn(),
    setSessionKey: vi.fn(),
  } as unknown as SessionStore;
}

function makeState(sessionId: string, sessionKey: string): SessionState {
  return {
    sessionId,
    sessionKey,
    state: "WORKING",
    lastHookEvent: "UserPromptSubmit",
    lastHookPayload: {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
    },
    stateSince: Date.now(),
    lastSeenAt: Date.now(),
    history: [],
  } as SessionState;
}

async function drainEvents(events: AsyncIterable<import("openclaw/plugin-sdk/acp-runtime").AcpRuntimeEvent>) {
  const collected: import("openclaw/plugin-sdk/acp-runtime").AcpRuntimeEvent[] = [];
  for await (const ev of events) {
    collected.push(ev);
  }
  return collected;
}

describe("AcpEventStreamer", () => {
  it("emits status and done events on DONE hook", async () => {
    const sessionId = "sess-1";
    const sessionKey = "agent:claude-code:acp:test-1";
    const store = createMockStore([makeState(sessionId, sessionKey)]);
    const streamer = createAcpEventStreamer(store);
    const { events, result } = streamer.startTurn({
      sessionKey,
      requestId: "req-1",
      tmuxSession: "cc-test",
      timeoutMs: 10_000,
      readOutput: async () => "final output",
    });

    const eventsPromise = drainEvents(events);
    streamer.notifyState(sessionId, "DONE");

    const collected = await eventsPromise;
    const res = await result;

    expect(collected.map((e) => e.type)).toEqual([
      "status",
      "text_delta",
      "done",
    ]);
    expect(collected[0]).toEqual({ type: "status", text: "Claude Code is working..." });
    expect(collected[1]).toEqual({ type: "text_delta", text: "final output" });
    expect(collected[2]).toEqual({ type: "done" });
    expect(res).toEqual({ status: "completed" });
  });

  it("emits error event on FATAL hook", async () => {
    const sessionId = "sess-2";
    const sessionKey = "agent:claude-code:acp:test-2";
    const store = createMockStore([makeState(sessionId, sessionKey)]);
    const streamer = createAcpEventStreamer(store);
    const { events, result } = streamer.startTurn({
      sessionKey,
      requestId: "req-2",
      tmuxSession: "cc-test",
      timeoutMs: 10_000,
      readOutput: async () => "boom",
    });

    const eventsPromise = drainEvents(events);
    streamer.notifyState(sessionId, "FATAL");

    const collected = await eventsPromise;
    const res = await result;

    expect(collected.map((e) => e.type)).toEqual(["status", "error"]);
    expect(res).toEqual({
      status: "failed",
      error: { message: "boom", code: "ACP_TURN_FAILED" },
    });
  });

  it("resolves with stopReason on PERMISSION hook", async () => {
    const sessionId = "sess-3";
    const sessionKey = "agent:claude-code:acp:test-3";
    const store = createMockStore([makeState(sessionId, sessionKey)]);
    const streamer = createAcpEventStreamer(store);
    const { events, result } = streamer.startTurn({
      sessionKey,
      requestId: "req-3",
      tmuxSession: "cc-test",
      timeoutMs: 10_000,
      readOutput: async () => "permission needed",
    });

    const eventsPromise = drainEvents(events);
    streamer.notifyState(sessionId, "PERMISSION");

    const collected = await eventsPromise;
    const res = await result;

    expect(collected.map((e) => e.type)).toEqual(["status", "text_delta", "done"]);
    expect(res).toEqual({ status: "completed", stopReason: "PERMISSION" });
  });

  it("cancels a pending turn", async () => {
    const sessionId = "sess-4";
    const sessionKey = "agent:claude-code:acp:test-4";
    const store = createMockStore([makeState(sessionId, sessionKey)]);
    const streamer = createAcpEventStreamer(store);
    const { events, result, cancel } = streamer.startTurn({
      sessionKey,
      requestId: "req-4",
      tmuxSession: "cc-test",
      timeoutMs: 10_000,
      readOutput: async () => "",
    });

    const eventsPromise = drainEvents(events);
    cancel();

    const collected = await eventsPromise;
    const res = await result;

    expect(collected.map((e) => e.type)).toEqual(["status", "error"]);
    expect(res).toEqual({ status: "cancelled" });
  });

  it("times out if no terminal hook arrives", async () => {
    const sessionId = "sess-5";
    const sessionKey = "agent:claude-code:acp:test-5";
    const store = createMockStore([makeState(sessionId, sessionKey)]);
    const streamer = createAcpEventStreamer(store);
    const { events, result } = streamer.startTurn({
      sessionKey,
      requestId: "req-5",
      tmuxSession: "cc-test",
      timeoutMs: 10,
      readOutput: async () => "",
    });

    const collected = await drainEvents(events);
    const res = await result;

    expect(collected.map((e) => e.type)).toEqual(["status", "error"]);
    expect(res).toEqual({
      status: "failed",
      error: {
        message: "Turn timed out waiting for terminal hook",
        code: "ACP_TURN_FAILED",
      },
    });
  });
});
