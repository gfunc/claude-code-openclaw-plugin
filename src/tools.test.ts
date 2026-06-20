import { describe, expect, it } from "vitest";
import { createClaudeCodeStatusTool } from "./tools.js";
import { createSessionStore } from "./store.js";

describe("claude_code_status tool", () => {
  it("returns active sessions", async () => {
    const store = createSessionStore({ stateFileDir: "/tmp/tools-test" });
    await store.applyHook({ hook_event_name: "Stop", session_id: "s1" });
    const tool = createClaudeCodeStatusTool(store);
    const result = await tool.execute("tc-1", {});
    const details = result.details as { sessions: Array<{ sessionId: string }> };
    expect(details.sessions).toHaveLength(1);
    expect(details.sessions[0].sessionId).toBe("s1");
  });

  it("filters by state", async () => {
    const store = createSessionStore({ stateFileDir: "/tmp/tools-test-filter" });
    await store.applyHook({ hook_event_name: "Stop", session_id: "s1" });
    await store.applyHook({ hook_event_name: "SessionStart", session_id: "s2" });
    const tool = createClaudeCodeStatusTool(store);
    const result = await tool.execute("tc-1", { state: "WAITING" });
    const details = result.details as { sessions: Array<{ sessionId: string }> };
    expect(details.sessions).toHaveLength(1);
    expect(details.sessions[0].sessionId).toBe("s1");
  });
});
