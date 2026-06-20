import { describe, expect, it } from "vitest";
import { createClaudeCodeStatusTool } from "./tools.js";
import { createSessionStore } from "./store.js";

describe("claude_code_status tool", () => {
  it("returns active sessions", async () => {
    const store = createSessionStore({ stateFileDir: "/tmp/tools-test" });
    await store.applyHook({ hook_event_name: "Stop", session_id: "s1" });
    const tool = createClaudeCodeStatusTool(store);
    const result = await tool.execute({});
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe("s1");
  });
});
