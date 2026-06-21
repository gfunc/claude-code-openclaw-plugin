import { describe, expect, it, vi } from "vitest";
import { stopSession, createClaudeCodeStopTool } from "./stop.js";

describe("claude_code_stop tool", () => {
  it("stops a discovered session", async () => {
    const exec = vi.fn();
    exec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }); // has-session
    exec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }); // kill-session

    const result = await stopSession({
      sessionName: "cc-test",
      exec,
      tasksDir: "/tmp/stop-test",
      writeState: async () => {},
      killWatchdog: async () => {},
    });

    expect(result.success).toBe(true);
    expect(exec).toHaveBeenCalledWith(["tmux", "has-session", "-t", "cc-test"], { timeoutMs: 2000 });
    expect(exec).toHaveBeenCalledWith(["tmux", "kill-session", "-t", "cc-test"], { timeoutMs: 5000 });
  });

  it("returns not found when session does not exist", async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    const result = await stopSession({
      sessionName: "cc-missing",
      exec,
      tasksDir: "/tmp/stop-test",
      writeState: async () => {},
      killWatchdog: async () => {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not alive");
  });
});
