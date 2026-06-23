import { describe, expect, it, vi } from "vitest";
import { spawnSession, createClaudeCodeSpawnTool } from "./spawn.js";

describe("claude_code_spawn tool", () => {
  it("spawns a session with expected tmux commands", async () => {
    const exec = vi.fn();
    exec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }); // kill-session
    exec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }); // new-session
    exec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }); // pipe-pane
    exec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }); // capture-pane
    exec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }); // load-buffer
    exec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }); // paste-buffer

    const writeState = vi.fn().mockResolvedValue(undefined);
    const startWatchdog = vi.fn().mockResolvedValue(undefined);

    const result = await spawnSession({
      tmuxSession: "cc-test",
      task: "echo hello",
      budgetMinutes: 5,
      workdir: "/tmp",
      exec,
      writeState,
      startWatchdog,
      uuid: () => "test-uuid",
      sleepMs: 0,
    });

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe("test-uuid");
    expect(exec).toHaveBeenCalledWith(
      expect.arrayContaining(["tmux", "new-session", "-d", "-s", "cc-test"]),
      { timeoutMs: 10000 },
    );
    expect(writeState).toHaveBeenCalled();
    expect(startWatchdog).toHaveBeenCalled();
  });

  it("rejects unsafe tmux session names before running any command", async () => {
    const exec = vi.fn();
    const result = await spawnSession({
      tmuxSession: "cc; rm -rf ~",
      task: "echo hi",
      exec,
      writeState: vi.fn(),
      startWatchdog: vi.fn(),
      uuid: () => "test-uuid",
      sleepMs: 0,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("unsafe tmux session");
    expect(exec).not.toHaveBeenCalled();
  });
});
