import { describe, it, expect, vi } from "vitest";
import { createClaudeCodeAcpRuntime } from "./claude-code-acp-runtime.js";
import type { AcpSessionManager } from "./session-manager.js";
import type { AcpTmuxRuntime } from "./tmux-runtime.js";
import type { AcpEventStreamer } from "./event-streamer.js";
import type { SessionStore } from "../store.js";
import type { ExecFn } from "../tmux.js";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";

function spawnResult(overrides?: Partial<SpawnResult>): SpawnResult {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

function createMocks() {
  const sessionManager: AcpSessionManager = {
    ensureSession: vi.fn(),
    close: vi.fn(),
    getHandle: vi.fn(),
    getSidecar: vi.fn(),
    loadFromDisk: vi.fn(),
  };
  const tmuxRuntime: AcpTmuxRuntime = {
    send: vi.fn().mockResolvedValue(undefined),
    sendKeys: vi.fn(),
    read: vi.fn().mockResolvedValue(""),
    exists: vi.fn().mockResolvedValue(true),
    kill: vi.fn(),
    ctrlC: vi.fn().mockResolvedValue(undefined),
  };
  const eventStreamer: AcpEventStreamer = {
    startTurn: vi.fn(),
    notifyState: vi.fn(),
    cancelTurn: vi.fn(),
  };
  const store: SessionStore = {
    setSessionKey: vi.fn(),
    applyHook: vi.fn(),
    markFatal: vi.fn(),
    getState: vi.fn(),
    listStates: vi.fn(),
    loadFromDisk: vi.fn(),
    dispose: vi.fn(),
    setNotifyContext: vi.fn(),
  } as unknown as SessionStore;
  const exec: ExecFn = vi.fn(async () => spawnResult());
  const log = vi.fn();
  return { sessionManager, tmuxRuntime, eventStreamer, store, exec, log };
}

describe("ClaudeCodeAcpRuntime", () => {
  it("ensureSession delegates and stores sessionKey mapping", async () => {
    const mocks = createMocks();
    const runtime = createClaudeCodeAcpRuntime(mocks);
    const handle = {
      sessionKey: "agent:claude-code:acp:test",
      backend: "claude-code",
      runtimeSessionName: "cc-1234",
      backendSessionId: "sess-1234",
    };
    vi.mocked(mocks.sessionManager.ensureSession).mockResolvedValue(handle);

    const result = await runtime.ensureSession({
      sessionKey: handle.sessionKey,
      agent: "claude-code",
      mode: "oneshot",
    });

    expect(result).toBe(handle);
    expect(mocks.store.setSessionKey).toHaveBeenCalledWith("sess-1234", handle.sessionKey);
  });

  it("startTurn sends text and returns turn", async () => {
    const mocks = createMocks();
    const runtime = createClaudeCodeAcpRuntime(mocks);
    const handle = {
      sessionKey: "agent:claude-code:acp:test",
      backend: "claude-code",
      runtimeSessionName: "cc-1234",
      backendSessionId: "sess-1234",
    };
    vi.mocked(mocks.sessionManager.getHandle).mockReturnValue(handle);
    const events = (async function* () {
      yield { type: "done" } as import("openclaw/plugin-sdk/acp-runtime").AcpRuntimeEvent;
    })();
    vi.mocked(mocks.eventStreamer.startTurn).mockReturnValue({
      events,
      result: Promise.resolve({ status: "completed" }),
      cancel: vi.fn(),
    });

    const turn = runtime.startTurn!({
      handle,
      text: "do the thing",
      mode: "prompt",
      requestId: "req-1",
    });

    expect(mocks.tmuxRuntime.send).toHaveBeenCalledWith("cc-1234", "do the thing");
    expect(mocks.eventStreamer.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: handle.sessionKey,
        requestId: "req-1",
        tmuxSession: "cc-1234",
      }),
    );
    expect(turn.requestId).toBe("req-1");
  });

  it("cancel calls eventStreamer and tmux ctrl-c", async () => {
    const mocks = createMocks();
    const runtime = createClaudeCodeAcpRuntime(mocks);
    const handle = {
      sessionKey: "agent:claude-code:acp:test",
      backend: "claude-code",
      runtimeSessionName: "cc-1234",
    };
    vi.mocked(mocks.sessionManager.getHandle).mockReturnValue(handle);

    await runtime.cancel({ handle, reason: "user request" });

    expect(mocks.eventStreamer.cancelTurn).toHaveBeenCalledWith(handle.sessionKey);
    expect(mocks.tmuxRuntime.ctrlC).toHaveBeenCalledWith("cc-1234");
  });

  it("close delegates to sessionManager", async () => {
    const mocks = createMocks();
    const runtime = createClaudeCodeAcpRuntime(mocks);
    const handle = {
      sessionKey: "agent:claude-code:acp:test",
      backend: "claude-code",
      runtimeSessionName: "cc-1234",
    };

    await runtime.close({ handle, reason: "done", discardPersistentState: true });

    expect(mocks.sessionManager.close).toHaveBeenCalledWith(handle.sessionKey, true);
  });

  it("doctor reports ok when claude and tmux are available", async () => {
    const mocks = createMocks();
    vi.mocked(mocks.exec)
      .mockResolvedValueOnce(spawnResult({ stdout: "claude 1.2.3\n" }))
      .mockResolvedValueOnce(spawnResult({ stdout: "tmux 3.4\n" }));
    const runtime = createClaudeCodeAcpRuntime(mocks);

    const report = await runtime.doctor!();

    expect(report.ok).toBe(true);
    expect(report.message).toBe("claude-code backend ready");
  });

  it("doctor reports failure when claude is missing", async () => {
    const mocks = createMocks();
    vi.mocked(mocks.exec).mockRejectedValue(new Error("not found"));
    const runtime = createClaudeCodeAcpRuntime(mocks);

    const report = await runtime.doctor!();

    expect(report.ok).toBe(false);
    expect(report.message).toContain("claude CLI");
  });
});
