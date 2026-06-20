import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  deriveState,
  buildInitialState,
  applyHook,
  type ClaudeCodeHookPayload,
  type SessionState,
} from "./state.js";

describe("deriveState", () => {
  it("maps SessionStart to WORKING", () => {
    const result = deriveState({ hook_event_name: "SessionStart", session_id: "s1" });
    expect(result.state).toBe("WORKING");
  });

  it("maps UserPromptSubmit to WORKING", () => {
    const result = deriveState({ hook_event_name: "UserPromptSubmit", session_id: "s1" });
    expect(result.state).toBe("WORKING");
  });

  it("maps PreToolUse to WORKING", () => {
    const result = deriveState({ hook_event_name: "PreToolUse", session_id: "s1" });
    expect(result.state).toBe("WORKING");
  });

  it("maps PostToolUse to WORKING", () => {
    const result = deriveState({ hook_event_name: "PostToolUse", session_id: "s1" });
    expect(result.state).toBe("WORKING");
  });

  it("maps PostToolUseFailure to ERROR", () => {
    const result = deriveState({ hook_event_name: "PostToolUseFailure", session_id: "s1" });
    expect(result.state).toBe("ERROR");
  });

  it("maps PermissionRequest to PERMISSION", () => {
    const result = deriveState({ hook_event_name: "PermissionRequest", session_id: "s1" });
    expect(result.state).toBe("PERMISSION");
  });

  it("maps SessionEnd to DONE", () => {
    const result = deriveState({ hook_event_name: "SessionEnd", session_id: "s1" });
    expect(result.state).toBe("DONE");
  });

  it("maps Stop to WAITING", () => {
    const result = deriveState({ hook_event_name: "Stop", session_id: "s1" });
    expect(result.state).toBe("WAITING");
  });

  it("maps FileChanged to WORKING", () => {
    const result = deriveState({ hook_event_name: "FileChanged", session_id: "s1" });
    expect(result.state).toBe("WORKING");
  });

  it("maps CwdChanged to WORKING", () => {
    const result = deriveState({ hook_event_name: "CwdChanged", session_id: "s1" });
    expect(result.state).toBe("WORKING");
  });

  it("includes tool_name when present", () => {
    const result = deriveState({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash" });
    expect(result.tool).toBe("Bash");
  });
});

describe("buildInitialState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets stateSince and lastSeenAt timestamps", () => {
    const payload: ClaudeCodeHookPayload = { hook_event_name: "SessionStart", session_id: "s1" };
    const state = buildInitialState(payload);
    expect(state.stateSince).toBe(1000);
    expect(state.lastSeenAt).toBe(1000);
  });

  it("initializes history with the first event", () => {
    const payload: ClaudeCodeHookPayload = { hook_event_name: "SessionStart", session_id: "s1" };
    const state = buildInitialState(payload);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toEqual({ ts: 1000, state: "WORKING", event: "SessionStart", tool: undefined });
  });

  it("stores a copy of payload as lastHookPayload", () => {
    const payload: ClaudeCodeHookPayload = { hook_event_name: "SessionStart", session_id: "s1", cwd: "/tmp" };
    const state = buildInitialState(payload);
    expect(state.lastHookPayload).toEqual(payload);
    expect(state.lastHookPayload).not.toBe(payload);
  });
});

describe("applyHook", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeInitialState(): SessionState {
    return buildInitialState({ hook_event_name: "SessionStart", session_id: "s1", cwd: "/home" });
  }

  it("accumulates history entries", () => {
    const current = makeInitialState();
    vi.setSystemTime(2000);
    const next = applyHook(current, { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash" });
    expect(next.history).toHaveLength(2);
    expect(next.history[1]).toEqual({ ts: 2000, state: "WORKING", event: "PreToolUse", tool: "Bash" });
  });

  it("falls back to current workdir when payload lacks cwd", () => {
    const current = makeInitialState();
    const next = applyHook(current, { hook_event_name: "Stop", session_id: "s1" });
    expect(next.workdir).toBe("/home");
  });

  it("updates workdir when payload provides cwd", () => {
    const current = makeInitialState();
    const next = applyHook(current, { hook_event_name: "CwdChanged", session_id: "s1", cwd: "/tmp" });
    expect(next.workdir).toBe("/tmp");
  });

  it("updates stateSince when state changes", () => {
    const current = makeInitialState();
    vi.setSystemTime(2000);
    const next = applyHook(current, { hook_event_name: "Stop", session_id: "s1" });
    expect(next.state).toBe("WAITING");
    expect(next.stateSince).toBe(2000);
  });

  it("preserves stateSince when state does not change", () => {
    const current = makeInitialState();
    vi.setSystemTime(2000);
    const next = applyHook(current, { hook_event_name: "PreToolUse", session_id: "s1" });
    expect(next.state).toBe("WORKING");
    expect(next.stateSince).toBe(1000);
  });

  it("always updates lastSeenAt", () => {
    const current = makeInitialState();
    vi.setSystemTime(2000);
    const next = applyHook(current, { hook_event_name: "PreToolUse", session_id: "s1" });
    expect(next.lastSeenAt).toBe(2000);
  });

  it("stores a copy of payload as lastHookPayload", () => {
    const current = makeInitialState();
    const payload: ClaudeCodeHookPayload = { hook_event_name: "Stop", session_id: "s1" };
    const next = applyHook(current, payload);
    expect(next.lastHookPayload).toEqual(payload);
    expect(next.lastHookPayload).not.toBe(payload);
  });
});
