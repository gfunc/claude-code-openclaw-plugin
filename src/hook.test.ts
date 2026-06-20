import { describe, expect, it } from "vitest";
import { parseHookPayload } from "./hook.js";

describe("parseHookPayload", () => {
  it("accepts a valid PreToolUse payload", () => {
    const payload = parseHookPayload({
      hook_event_name: "PreToolUse",
      session_id: "s1",
      cwd: "/tmp",
      tool_name: "Bash",
    });
    expect(payload.hook_event_name).toBe("PreToolUse");
    expect(payload.session_id).toBe("s1");
  });

  it("rejects missing session_id", () => {
    expect(() => parseHookPayload({ hook_event_name: "Stop" })).toThrow();
  });

  it("rejects unknown event names", () => {
    expect(() =>
      parseHookPayload({ hook_event_name: "UnknownEvent", session_id: "s1" }),
    ).toThrow();
  });

  it("preserves extra unknown fields", () => {
    const payload = parseHookPayload({
      hook_event_name: "SessionStart",
      session_id: "s2",
      agent_type: "claude-code",
    });
    expect(payload.agent_type).toBe("claude-code");
  });

  it("accepts tool_input as an object", () => {
    const payload = parseHookPayload({
      hook_event_name: "PreToolUse",
      session_id: "s3",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    });
    expect(payload.tool_input).toEqual({ command: "echo hi" });
  });

  it("accepts tool_input as an array", () => {
    const payload = parseHookPayload({
      hook_event_name: "PreToolUse",
      session_id: "s4",
      tool_input: ["a", "b"],
    });
    expect(payload.tool_input).toEqual(["a", "b"]);
  });

  it("accepts tool_input as null", () => {
    const payload = parseHookPayload({
      hook_event_name: "PreToolUse",
      session_id: "s5",
      tool_input: null,
    });
    expect(payload.tool_input).toBeNull();
  });

  it("rejects empty session_id", () => {
    expect(() =>
      parseHookPayload({ hook_event_name: "Stop", session_id: "" }),
    ).toThrow();
  });
});
