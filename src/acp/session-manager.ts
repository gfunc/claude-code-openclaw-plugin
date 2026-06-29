import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { AcpRuntimeEnsureInput, AcpRuntimeHandle } from "openclaw/plugin-sdk/acp-runtime";
import type { AcpRuntimeDeps, AcpSessionSidecar } from "./types.js";
import { assertSafeSessionId, assertSafeTmuxSession, tmuxSessionExists } from "../tmux.js";

export type AcpSessionManager = {
  ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;
  close(sessionKey: string, discardPersistentState?: boolean): Promise<void>;
  getHandle(sessionKey: string): AcpRuntimeHandle | undefined;
  getSidecar(sessionKey: string): AcpSessionSidecar | undefined;
  loadFromDisk(): Promise<void>;
};

function sidecarFileName(sessionKey: string): string {
  const safe = sessionKey.replace(/[^a-z0-9_-]/gi, "_");
  return `${safe}.acp.json`;
}

function buildHandle(sidecar: AcpSessionSidecar): AcpRuntimeHandle {
  return {
    sessionKey: sidecar.sessionKey,
    backend: "claude-code",
    runtimeSessionName: sidecar.tmuxSessionName,
    cwd: sidecar.cwd,
    backendSessionId: sidecar.claudeCodeSessionId,
  };
}

export function createAcpSessionManager(deps: AcpRuntimeDeps): AcpSessionManager {
  const sidecars = new Map<string, AcpSessionSidecar>();

  function sidecarPath(sessionKey: string): string {
    return path.join(deps.stateFileDir, sidecarFileName(sessionKey));
  }

  async function writeSidecar(sidecar: AcpSessionSidecar): Promise<void> {
    await fs.mkdir(deps.stateFileDir, { recursive: true });
    await fs.writeFile(
      sidecarPath(sidecar.sessionKey),
      JSON.stringify(sidecar, null, 2) + "\n",
      "utf8",
    );
  }

  async function removeSidecar(sessionKey: string): Promise<void> {
    await fs.rm(sidecarPath(sessionKey), { force: true });
  }

  async function spawnClaudeSession(
    sidecar: AcpSessionSidecar,
    deps: AcpRuntimeDeps,
  ): Promise<void> {
    const { tmuxSessionName, claudeCodeSessionId, cwd, permissionMode } = sidecar;
    assertSafeTmuxSession(tmuxSessionName);
    assertSafeSessionId(claudeCodeSessionId);

    // Clean up any stale session with the same name
    await deps.exec(["tmux", "kill-session", "-t", tmuxSessionName], { timeoutMs: 5000 }).catch(() => {});

    const logFile = path.join(deps.tasksDir, `${tmuxSessionName}.log`);
    await fs.rm(logFile, { force: true });

    await deps.exec(
      [
        "tmux",
        "new-session",
        "-d",
        "-s",
        tmuxSessionName,
        "-c",
        cwd,
        `claude --session-id '${claudeCodeSessionId}' --permission-mode ${permissionMode}`,
      ],
      { timeoutMs: 10000 },
    );

    // Confirm tmux session exists
    if (!(await tmuxSessionExists(tmuxSessionName, deps.exec))) {
      throw new Error(`tmux session ${tmuxSessionName} did not start`);
    }

    // Pipe pane output to log file
    await deps.exec(
      ["tmux", "pipe-pane", "-t", tmuxSessionName, "-o", `cat >> '${logFile}'`],
      { timeoutMs: 5000 },
    );

    // Handle trust prompt
    await new Promise((r) => setTimeout(r, 5000));
    const capture = await deps.exec(
      ["tmux", "capture-pane", "-t", tmuxSessionName, "-p"],
      { timeoutMs: 5000 },
    );
    const stdout = capture.stdout ?? "";
    const trustThreeOption =
      /1\. Continue/i.test(stdout) &&
      /2\. Fix with Claude/i.test(stdout) &&
      /3\. Exit and fix manually/i.test(stdout) &&
      /Enter to confirm/i.test(stdout);
    const trustTwoOption =
      /Yes, I trust this folder/i.test(stdout) && /No, exit/i.test(stdout);
    if (trustThreeOption || trustTwoOption) {
      await deps.exec(["tmux", "send-keys", "-t", tmuxSessionName, "1"], { timeoutMs: 5000 });
      await new Promise((r) => setTimeout(r, 1000));
      await deps.exec(["tmux", "send-keys", "-t", tmuxSessionName, "Enter"], { timeoutMs: 5000 });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async function spawnClaudeResume(
    sidecar: AcpSessionSidecar,
    deps: AcpRuntimeDeps,
  ): Promise<void> {
    const { tmuxSessionName, claudeCodeSessionId, cwd, permissionMode } = sidecar;
    assertSafeTmuxSession(tmuxSessionName);
    assertSafeSessionId(claudeCodeSessionId);

    await deps.exec(["tmux", "kill-session", "-t", tmuxSessionName], { timeoutMs: 5000 }).catch(() => {});

    const logFile = path.join(deps.tasksDir, `${tmuxSessionName}.log`);
    await fs.rm(logFile, { force: true });

    await deps.exec(
      [
        "tmux",
        "new-session",
        "-d",
        "-s",
        tmuxSessionName,
        "-c",
        cwd,
        `claude --resume ${claudeCodeSessionId} --permission-mode ${permissionMode}`,
      ],
      { timeoutMs: 10000 },
    );

    if (!(await tmuxSessionExists(tmuxSessionName, deps.exec))) {
      throw new Error(`tmux session ${tmuxSessionName} did not start on resume`);
    }

    await deps.exec(
      ["tmux", "pipe-pane", "-t", tmuxSessionName, "-o", `cat >> '${logFile}'`],
      { timeoutMs: 5000 },
    );
  }

  return {
    async ensureSession(input) {
      const existing = sidecars.get(input.sessionKey);
      if (existing) {
        const alive = await tmuxSessionExists(existing.tmuxSessionName, deps.exec);
        if (alive) return buildHandle(existing);

        // Try resume
        if (existing.claudeCodeSessionId) {
          try {
            await spawnClaudeResume(existing, deps);
            if (await tmuxSessionExists(existing.tmuxSessionName, deps.exec)) {
              return buildHandle(existing);
            }
          } catch (err) {
            deps.log(`acp: resume failed for ${input.sessionKey}: ${String(err)}`);
          }
        }

        // Resume failed or no sessionId: clean up
        await removeSidecar(input.sessionKey);
        sidecars.delete(input.sessionKey);
      }

      // Spawn fresh
      const claudeCodeSessionId = crypto.randomUUID();
      const tmuxSessionName = `cc-${claudeCodeSessionId.slice(0, 8)}`;
      const sidecar: AcpSessionSidecar = {
        sessionKey: input.sessionKey,
        tmuxSessionName,
        claudeCodeSessionId,
        cwd: input.cwd ?? process.cwd(),
        mode: input.mode,
        startedAt: Date.now(),
        permissionMode: deps.permissionMode,
        budgetMinutes: deps.budgetMinutes,
      };

      await spawnClaudeSession(sidecar, deps);
      await writeSidecar(sidecar);
      sidecars.set(input.sessionKey, sidecar);
      return buildHandle(sidecar);
    },

    async close(sessionKey, discardPersistentState) {
      const sidecar = sidecars.get(sessionKey);
      if (!sidecar) return;

      const alive = await tmuxSessionExists(sidecar.tmuxSessionName, deps.exec);
      if (alive && (sidecar.mode === "oneshot" || discardPersistentState)) {
        await deps.exec(["tmux", "kill-session", "-t", sidecar.tmuxSessionName], { timeoutMs: 5000 });
      }

      if (sidecar.mode === "oneshot" || discardPersistentState) {
        await removeSidecar(sessionKey);
        sidecars.delete(sessionKey);
      }
    },

    getHandle(sessionKey) {
      const sidecar = sidecars.get(sessionKey);
      return sidecar ? buildHandle(sidecar) : undefined;
    },

    getSidecar(sessionKey) {
      return sidecars.get(sessionKey);
    },

    async loadFromDisk() {
      try {
        const entries = await fs.readdir(deps.stateFileDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".acp.json")) continue;
          const filePath = path.join(deps.stateFileDir, entry.name);
          try {
            const raw = await fs.readFile(filePath, "utf8");
            const parsed = JSON.parse(raw) as AcpSessionSidecar;
            if (
              parsed.sessionKey &&
              parsed.tmuxSessionName &&
              parsed.claudeCodeSessionId &&
              parsed.cwd &&
              parsed.mode &&
              typeof parsed.startedAt === "number"
            ) {
              sidecars.set(parsed.sessionKey, parsed);
            } else {
              deps.log(`acp: skipping invalid sidecar ${entry.name}`);
            }
          } catch (err) {
            deps.log(`acp: failed to load sidecar ${entry.name}: ${String(err)}`);
          }
        }
      } catch (err) {
        // Directory may not exist yet; that's fine
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          deps.log(`acp: failed to scan stateFileDir: ${String(err)}`);
        }
      }
    },
  };
}
