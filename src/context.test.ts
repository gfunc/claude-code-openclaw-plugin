import { describe, expect, it } from "vitest";
import { buildClaudeCodeContext } from "./context.js";
import type { SessionState } from "./state.js";

describe("buildClaudeCodeContext", () => {
  it("includes notify-worthy sessions", () => {
    const sessions: SessionState[] = [
      {
        sessionId: "s1",
        tmuxSession: "cc-bugfix",
        state: "WAITING",
        lastHookEvent: "Stop",
        lastHookPayload: { hook_event_name: "Stop", session_id: "s1" },
        stateSince: Date.now() - 5000,
        lastSeenAt: Date.now(),
        history: [],
      },
    ];
    const ctx = buildClaudeCodeContext({ sessions, notifyStates: ["WAITING", "ERROR"] });
    expect(ctx).toContain("cc-bugfix");
    expect(ctx).toContain("WAITING");
  });

  it("omits WORKING sessions", () => {
    const sessions: SessionState[] = [
      {
        sessionId: "s2",
        tmuxSession: "cc-other",
        state: "WORKING",
        lastHookEvent: "PreToolUse",
        lastHookPayload: { hook_event_name: "PreToolUse", session_id: "s2" },
        stateSince: Date.now(),
        lastSeenAt: Date.now(),
        history: [],
      },
    ];
    const ctx = buildClaudeCodeContext({ sessions, notifyStates: ["WAITING"] });
    expect(ctx).toBe("");
  });
});
