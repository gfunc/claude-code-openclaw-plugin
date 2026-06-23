import { describe, expect, it, vi } from "vitest";
import { restoreSession, createClaudeCodeRestoreTool } from "./restore.js";

describe("claude_code_restore tool", () => {
  it("resumes a session with expected tmux commands", async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    const writeState = vi.fn().mockResolvedValue(undefined);
    const startWatchdog = vi.fn().mockResolvedValue(undefined);

    const result = await restoreSession({
      sessionId: "sid-123",
      tmuxSession: "cc-resume",
      workdir: "/tmp",
      budgetMinutes: 10,
      exec,
      writeState,
      startWatchdog,
    });

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe("sid-123");
    expect(exec).toHaveBeenCalledWith(
      expect.arrayContaining(["tmux", "new-session", "-d", "-s", "cc-resume"]),
      { timeoutMs: 10000 },
    );
    expect(writeState).toHaveBeenCalled();
    expect(startWatchdog).toHaveBeenCalled();
  });

  it("rejects unsafe session ids before running any command", async () => {
    const exec = vi.fn();
    const result = await restoreSession({
      sessionId: "'; rm -rf ~; '",
      tmuxSession: "cc-resume",
      exec,
      writeState: vi.fn(),
      startWatchdog: vi.fn(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("unsafe session id");
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(["default", "acceptEdits", "plan", "bypassPermissions"] as const)(
    "passes permissionMode %s to the claude resume command",
    async (permissionMode) => {
      const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      const result = await restoreSession({
        sessionId: "sid-123",
        tmuxSession: "cc-resume",
        permissionMode,
        workdir: "/tmp",
        budgetMinutes: 10,
        exec,
        writeState: vi.fn(),
        startWatchdog: vi.fn(),
      });
      expect(result.success).toBe(true);
      const newSessionArgv = exec.mock.calls[1]?.[0] as string[];
      expect(newSessionArgv.join(" ")).toContain(`--permission-mode ${permissionMode}`);
    },
  );

  it("fails when the tmux session does not start", async () => {
    const exec = vi.fn();
    exec.mockImplementation((argv: string[]) =>
      Promise.resolve(
        argv.includes("has-session")
          ? { code: 1, stdout: "", stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
      ),
    );
    const result = await restoreSession({
      sessionId: "sid-123",
      tmuxSession: "cc-resume",
      exec,
      writeState: vi.fn(),
      startWatchdog: vi.fn(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("did not start");
  });
});
