import { describe, expect, it, vi } from "vitest";
import { createClaudeCodeReadTool, handleReadRoute, readSession } from "./read.js";
import * as tmux from "./tmux.js";

describe("claude_code_read", () => {
  it("returns the captured pane output", async () => {
    vi.spyOn(tmux, "tmuxSessionExists").mockResolvedValue(true);
    vi.spyOn(tmux, "capturePane").mockResolvedValue("Which database? 1) postgres 2) sqlite");

    const result = await readSession({ tmuxSession: "cc-test" });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Which database?");
    vi.restoreAllMocks();
  });

  it("returns failure when the session does not exist", async () => {
    vi.spyOn(tmux, "tmuxSessionExists").mockResolvedValue(false);
    const result = await readSession({ tmuxSession: "missing" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    vi.restoreAllMocks();
  });

  it("exposes a claude_code_read tool", () => {
    const tool = createClaudeCodeReadTool();
    expect(tool.name).toBe("claude_code_read");
  });

  it("validates tmuxSession in the HTTP route", async () => {
    const res = await handleReadRoute({});
    expect(res.status).toBe(400);
  });
});
