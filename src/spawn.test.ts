import { describe, expect, it, vi } from "vitest";
import { spawnSession, createClaudeCodeSpawnTool } from "./spawn.js";
import type { SessionStore } from "./store.js";

describe("claude_code_spawn tool", () => {
  it("spawns a session with expected tmux commands", async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });

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

  it("defaults to bypassPermissions in the launch command", async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    const result = await spawnSession({
      tmuxSession: "cc-test",
      task: "echo hello",
      budgetMinutes: 5,
      workdir: "/tmp",
      exec,
      writeState: vi.fn(),
      startWatchdog: vi.fn(),
      uuid: () => "test-uuid",
      sleepMs: 0,
    });

    expect(result.success).toBe(true);
    const newSessionArgv = exec.mock.calls[1]?.[0] as string[];
    expect(newSessionArgv.join(" ")).toContain("--permission-mode bypassPermissions");
  });

  it.each(["default", "acceptEdits", "plan", "bypassPermissions"] as const)(
    "passes permissionMode %s to the claude launch command",
    async (permissionMode) => {
      const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      const result = await spawnSession({
        tmuxSession: "cc-test",
        task: "echo hello",
        permissionMode,
        workdir: "/tmp",
        exec,
        writeState: vi.fn(),
        startWatchdog: vi.fn(),
        uuid: () => "test-uuid",
        sleepMs: 0,
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
    const result = await spawnSession({
      tmuxSession: "cc-test",
      task: "echo hello",
      workdir: "/tmp",
      exec,
      writeState: vi.fn(),
      startWatchdog: vi.fn(),
      uuid: () => "test-uuid",
      sleepMs: 0,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("did not start");
  });

  it("calls store.setNotifyContext with notifySessionKey + deliveryContext when provided", async () => {
    const setNotifyContext = vi.fn();
    const fakeStore = { setNotifyContext } as unknown as SessionStore;
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    const result = await spawnSession({
      tmuxSession: "cc-test",
      task: "do stuff",
      workdir: "/tmp",
      exec,
      writeState: vi.fn(),
      startWatchdog: vi.fn(),
      uuid: () => "sid-fixed",
      sleepMs: 0,
      store: fakeStore,
      notifySessionKey: "agent:wecom:user-1",
      notifyDeliveryContext: { channel: "wecom", to: "user-1" },
      defaultNotifySessionKey: "agent:main:main",
      checkHooksConfigured: async () => true,
    });

    expect(result.success).toBe(true);
    expect(setNotifyContext).toHaveBeenCalledWith("sid-fixed", {
      runId: "sid-fixed",
      notifySessionKey: "agent:wecom:user-1",
      notifyDeliveryContext: { channel: "wecom", to: "user-1" },
    });
  });

  it("falls back to defaultNotifySessionKey when notifySessionKey is omitted", async () => {
    const setNotifyContext = vi.fn();
    const fakeStore = { setNotifyContext } as unknown as SessionStore;
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await spawnSession({
      tmuxSession: "cc-test-2",
      task: "do stuff",
      workdir: "/tmp",
      exec,
      writeState: vi.fn(),
      startWatchdog: vi.fn(),
      uuid: () => "sid-fixed-2",
      sleepMs: 0,
      store: fakeStore,
      defaultNotifySessionKey: "agent:notifications:claude-code",
      checkHooksConfigured: async () => true,
    });

    expect(setNotifyContext).toHaveBeenCalledWith("sid-fixed-2", {
      runId: "sid-fixed-2",
      notifySessionKey: "agent:notifications:claude-code",
      notifyDeliveryContext: undefined,
    });
  });

  it("does not call setNotifyContext when store is absent", async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const result = await spawnSession({
      tmuxSession: "cc-no-store",
      task: "do stuff",
      workdir: "/tmp",
      exec,
      writeState: vi.fn(),
      startWatchdog: vi.fn(),
      uuid: () => "sid-no-store",
      sleepMs: 0,
      checkHooksConfigured: async () => true,
    });
    expect(result.success).toBe(true);
  });
});
