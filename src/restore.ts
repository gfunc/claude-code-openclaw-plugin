import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import type { ExecFn } from "./tmux.js";
import { assertSafeSessionId, assertSafeTmuxSession } from "./tmux.js";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export type RestoreDeps = {
  exec?: ExecFn;
  tasksDir?: string;
  writeState?: (statePath: string, line: string) => Promise<void>;
  startWatchdog?: (statePath: string, sessionId: string, tmuxSession: string, budgetMinutes: number) => Promise<void>;
};

const DEFAULT_TASKS_DIR = path.join(os.homedir(), ".cache", "claude-tasks");

async function defaultWriteState(statePath: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, line, "utf8");
}

async function defaultStartWatchdog(
  statePath: string,
  sessionId: string,
  tmuxSession: string,
  budgetMinutes: number,
): Promise<void> {
  const watchdogPath = `${statePath}.watchdog`;
  const script = `
HOOK_STATE="$HOME/.cache/claude-code-hooks/${sessionId}.json"
GRACE_MIN=$(( ${budgetMinutes} + 5 ))
while true; do
  sleep 30
  if [ -f "\$HOOK_STATE" ]; then
    LAST_TOUCH=$(stat -c %Y "\$HOOK_STATE" 2>/dev/null || echo 0)
    NOW=$(date +%s)
    IDLE_MIN=$(( (NOW - LAST_TOUCH) / 60 ))
    if [ "\$IDLE_MIN" -ge "${budgetMinutes}" ]; then
      if tmux has-session -t "${tmuxSession}" 2>/dev/null; then
        tmux kill-session -t "${tmuxSession}" 2>/dev/null
        echo "BUDGET_EXCEEDED_IDLE $(date +%s) resumed_from=${sessionId} idle_min=\$IDLE_MIN" >> "${statePath}"
      fi
      break
    fi
  else
    NOW=$(date +%s)
    START_S=$(stat -c %Y "${statePath}" 2>/dev/null || echo \$NOW)
    ELAPSED_MIN=$(( (NOW - START_S) / 60 ))
    if [ "\$ELAPSED_MIN" -ge "\$GRACE_MIN" ]; then
      if tmux has-session -t "${tmuxSession}" 2>/dev/null; then
        tmux kill-session -t "${tmuxSession}" 2>/dev/null
        echo "BUDGET_EXCEEDED_NO_HOOKS $(date +%s) resumed_from=${sessionId} elapsed_min=\$ELAPSED_MIN" >> "${statePath}"
      fi
      break
    fi
  fi
done
`.trim();
  const child = spawn("bash", ["-c", script], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
  if (child.pid) {
    await fs.writeFile(watchdogPath, String(child.pid), "utf8").catch(() => {});
  }
}

export async function restoreSession({
  sessionId,
  tmuxSession = "cc-resume",
  workdir = process.cwd(),
  budgetMinutes = 30,
  exec = runCommandWithTimeout,
  tasksDir = DEFAULT_TASKS_DIR,
  writeState = defaultWriteState,
  startWatchdog = defaultStartWatchdog,
}: {
  sessionId: string;
  tmuxSession?: string;
  workdir?: string;
  budgetMinutes?: number;
} & RestoreDeps): Promise<{
  success: boolean;
  sessionId: string;
  tmuxSession: string;
  budgetMinutes: number;
  workdir: string;
  logFile: string;
  stateFile: string;
  error?: string;
}> {
  const logFile = path.join(tasksDir, `${tmuxSession}.log`);
  const stateFile = path.join(tasksDir, `${tmuxSession}.state`);

  try {
    // sessionId is caller-supplied and is interpolated into a shell command
    // string (`claude --resume '<id>'`) plus the watchdog script; validate both
    // before they ever reach a shell.
    assertSafeSessionId(sessionId);
    assertSafeTmuxSession(tmuxSession);
    await exec(["tmux", "kill-session", "-t", tmuxSession], { timeoutMs: 5000 }).catch(() => {});
    await fs.rm(logFile, { force: true });
    await fs.rm(stateFile, { force: true });
    await fs.rm(`${stateFile}.watchdog`, { force: true });

    await exec(
      [
        "tmux",
        "new-session",
        "-d",
        "-s",
        tmuxSession,
        "-c",
        workdir,
        `claude --resume '${sessionId}' --permission-mode bypassPermissions 2>&1 | tee '${logFile}'`,
      ],
      { timeoutMs: 10000 },
    );

    const stateLine = `RUNNING ${Date.now() / 1000 | 0} budget=${budgetMinutes}min workdir=${workdir} resumed_from=${sessionId}\n`;
    await writeState(stateFile, stateLine);
    await startWatchdog(stateFile, sessionId, tmuxSession, budgetMinutes);

    return {
      success: true,
      sessionId,
      tmuxSession,
      budgetMinutes,
      workdir,
      logFile,
      stateFile,
    };
  } catch (err) {
    return {
      success: false,
      sessionId,
      tmuxSession,
      budgetMinutes,
      workdir,
      logFile,
      stateFile,
      error: String(err),
    };
  }
}

export function createClaudeCodeRestoreTool(_config?: unknown): AnyAgentTool {
  return {
    label: "Claude Code Restore",
    name: "claude_code_restore",
    description: "Resume a previous Claude Code session id in a new tmux session.",
    parameters: Type.Object({
      sessionId: Type.String({ description: "Claude Code session id to resume" }),
      tmuxSession: Type.Optional(Type.String({ description: "Name for the new tmux session (default cc-resume)" })),
      workdir: Type.Optional(Type.String({ description: "Working directory (default cwd)" })),
      budgetMinutes: Type.Optional(Type.Number({ description: "Idle budget in minutes (default 30)" })),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const { sessionId, tmuxSession, workdir, budgetMinutes } = params as {
        sessionId: string;
        tmuxSession?: string;
        workdir?: string;
        budgetMinutes?: number;
      };
      const result = await restoreSession({ sessionId, tmuxSession, workdir, budgetMinutes });
      return jsonResult(result);
    },
  };
}

export async function handleRestoreRoute(body: unknown): Promise<{ status: number; body: unknown }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: 400, body: { error: "invalid body" } };
  }
  const { sessionId, tmuxSession, workdir, budgetMinutes } = body as Record<string, unknown>;
  if (typeof sessionId !== "string") {
    return { status: 400, body: { error: "sessionId is required" } };
  }
  const result = await restoreSession({
    sessionId,
    tmuxSession: typeof tmuxSession === "string" ? tmuxSession : undefined,
    workdir: typeof workdir === "string" ? workdir : undefined,
    budgetMinutes: typeof budgetMinutes === "number" ? budgetMinutes : undefined,
  });
  return { status: result.success ? 200 : 500, body: result };
}
