import { describe, expect, it } from "vitest";
import { buildClaudeCodeContext } from "./context.js";
import type { SessionState } from "./state.js";

function makeSession(
  state: SessionState["state"],
  overrides?: Partial<SessionState>,
): SessionState {
  return {
    sessionId: "s1",
    tmuxSession: "cc-test",
    state,
    lastHookEvent: "SessionStart",
    lastHookPayload: { hook_event_name: "SessionStart", session_id: "s1" },
    stateSince: Date.now() - 5000,
    lastSeenAt: Date.now(),
    history: [],
    ...overrides,
  };
}

describe("buildClaudeCodeContext", () => {
  it("includes WAITING with warning prefix", () => {
    const ctx = buildClaudeCodeContext({ sessions: [makeSession("WAITING")] });
    expect(ctx).toContain("## Active Claude Code sessions");
    expect(ctx).toContain("⚠️");
    expect(ctx).toContain("cc-test");
    expect(ctx).toContain("WAITING");
    expect(ctx).toContain("waiting for input");
  });

  it("includes FATAL with error prefix and reason", () => {
    const ctx = buildClaudeCodeContext({
      sessions: [makeSession("FATAL", { fatalReason: "no hook" })],
    });
    expect(ctx).toContain("🚨");
    expect(ctx).toContain("timed out");
    expect(ctx).toContain("no hook");
  });

  it("omits WORKING sessions", () => {
    const ctx = buildClaudeCodeContext({ sessions: [makeSession("WORKING")] });
    expect(ctx).toBe("");
  });

  it("sorts by urgency: FATAL/ERROR first, then WAITING/QUESTION/PERMISSION, then DONE", () => {
    const sessions = [
      makeSession("DONE", { sessionId: "done", tmuxSession: "cc-done" }),
      makeSession("FATAL", { sessionId: "fatal", tmuxSession: "cc-fatal" }),
      makeSession("WAITING", { sessionId: "waiting", tmuxSession: "cc-wait" }),
    ];
    const ctx = buildClaudeCodeContext({ sessions });
    const fatalIdx = ctx.indexOf("cc-fatal");
    const waitIdx = ctx.indexOf("cc-wait");
    const doneIdx = ctx.indexOf("cc-done");
    expect(fatalIdx).toBeLessThan(waitIdx);
    expect(waitIdx).toBeLessThan(doneIdx);
  });

});
