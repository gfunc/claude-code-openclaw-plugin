import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createAcpSessionManager } from "./session-manager.js";
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

describe("AcpSessionManager", () => {
  const tmpDir = path.join(os.tmpdir(), "acp-session-manager-test");

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a new session sidecar", async () => {
    const execCalls: string[][] = [];
    const exec: ExecFn = async (argv) => {
      execCalls.push(argv);
      const key = argv.join(" ");
      if (key.startsWith("tmux has-session -t cc-")) {
        return spawnResult();
      }
      if (key.startsWith("tmux kill-session -t cc-")) return spawnResult();
      if (key.startsWith("tmux new-session -d -s cc-")) return spawnResult();
      if (key.startsWith("tmux pipe-pane -t cc-")) return spawnResult();
      if (key.startsWith("tmux capture-pane -t cc-")) return spawnResult();
      return spawnResult();
    };

    const mgr = createAcpSessionManager({
      exec,
      stateFileDir: tmpDir,
      tasksDir: tmpDir,
      log: () => {},
      permissionMode: "bypassPermissions",
      budgetMinutes: 30,
      allowedTools: [],
    });
    const handle = await mgr.ensureSession({
      sessionKey: "agent:claude-code:acp:test-1",
      agent: "claude-code",
      mode: "oneshot",
      cwd: "/tmp",
    });
    expect(handle.backend).toBe("claude-code");
    expect(handle.runtimeSessionName).toMatch(/^cc-/);
    const sidecar = mgr.getSidecar("agent:claude-code:acp:test-1");
    expect(sidecar).toBeDefined();
    expect(sidecar?.mode).toBe("oneshot");

    // Verify sidecar was written to disk
    const files = await fs.readdir(tmpDir);
    expect(files.some((f) => f.endsWith(".acp.json"))).toBe(true);
  }, 15000);

  it("rehydrates from sidecar when tmux is alive", async () => {
    const sidecar = {
      sessionKey: "agent:claude-code:acp:test-2",
      tmuxSession: "cc-existing",
      sessionId: "sess-existing",
      cwd: "/tmp",
      mode: "persistent" as const,
      startedAt: Date.now(),
      permissionMode: "bypassPermissions" as const,
      budgetMinutes: 30,
    };
    await fs.writeFile(
      path.join(tmpDir, "agent_claude-code_acp_test-2.acp.json"),
      JSON.stringify(sidecar),
      "utf8",
    );

    const exec: ExecFn = async (argv) => {
      const key = argv.join(" ");
      if (key === "tmux has-session -t cc-existing") return spawnResult();
      return spawnResult();
    };

    const mgr = createAcpSessionManager({
      exec,
      stateFileDir: tmpDir,
      tasksDir: tmpDir,
      log: () => {},
      permissionMode: "bypassPermissions",
      budgetMinutes: 30,
      allowedTools: [],
    });
    await mgr.loadFromDisk();
    const handle = await mgr.ensureSession({
      sessionKey: "agent:claude-code:acp:test-2",
      agent: "claude-code",
      mode: "persistent",
      cwd: "/tmp",
    });
    expect(handle.runtimeSessionName).toBe("cc-existing");
  });

  it("resumes dead tmux with claude --resume", async () => {
    const sidecar = {
      sessionKey: "agent:claude-code:acp:test-3",
      tmuxSession: "cc-dead",
      sessionId: "dead-sess",
      cwd: "/tmp",
      mode: "persistent" as const,
      startedAt: Date.now(),
      permissionMode: "bypassPermissions" as const,
      budgetMinutes: 30,
    };
    await fs.writeFile(
      path.join(tmpDir, "agent_claude-code_acp_test-3.acp.json"),
      JSON.stringify(sidecar),
      "utf8",
    );

    const execCalls: string[][] = [];
    const exec: ExecFn = async (argv) => {
      execCalls.push(argv);
      const key = argv.join(" ");
      if (key === "tmux has-session -t cc-dead") return spawnResult({ code: 1 });
      if (key.startsWith("tmux kill-session -t cc-dead")) return spawnResult();
      if (key.startsWith("tmux new-session") && key.includes("--resume dead-sess")) return spawnResult();
      if (key.startsWith("tmux pipe-pane -t cc-dead")) return spawnResult();
      return spawnResult();
    };

    const mgr = createAcpSessionManager({
      exec,
      stateFileDir: tmpDir,
      tasksDir: tmpDir,
      log: () => {},
      permissionMode: "bypassPermissions",
      budgetMinutes: 30,
      allowedTools: [],
    });
    await mgr.loadFromDisk();
    await mgr.ensureSession({
      sessionKey: "agent:claude-code:acp:test-3",
      agent: "claude-code",
      mode: "persistent",
      cwd: "/tmp",
    });

    const resumeCall = execCalls.find((c) => c.join(" ").includes("--resume dead-sess"));
    expect(resumeCall).toBeDefined();
  }, 15000);
});
