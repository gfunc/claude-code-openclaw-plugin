import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import type { ExecFn } from "./tmux.js";
import { assertSafeSessionId, assertSafeTmuxSession } from "./tmux.js";
import type { ClaudePermissionMode } from "./config.js";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export type SpawnDeps = {
  exec?: ExecFn;
  tasksDir?: string;
  writeState?: (statePath: string, line: string) => Promise<void>;
  startWatchdog?: (statePath: string, sessionId: string, tmuxSession: string, budgetMinutes: number) => Promise<void>;
  uuid?: () => string;
  sleepMs?: number;
};

const DEFAULT_TASKS_DIR = path.join(os.homedir(), ".cache", "claude-tasks");

function defaultUuid(): string {
  return crypto.randomUUID();
}

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
        echo "BUDGET_EXCEEDED_IDLE $(date +%s) session_id=${sessionId} idle_min=\$IDLE_MIN budget_min=${budgetMinutes}" >> "${statePath}"
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
        echo "BUDGET_EXCEEDED_NO_HOOKS $(date +%s) session_id=${sessionId} elapsed_min=\$ELAPSED_MIN" >> "${statePath}"
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

export async function spawnSession({
  tmuxSession,
  task,
  budgetMinutes = 30,
  permissionMode = "bypassPermissions",
  workdir = process.cwd(),
  exec = runCommandWithTimeout,
  tasksDir = DEFAULT_TASKS_DIR,
  writeState = defaultWriteState,
  startWatchdog = defaultStartWatchdog,
  uuid = defaultUuid,
  sleepMs = 5000,
}: {
  tmuxSession: string;
  task: string;
  budgetMinutes?: number;
  permissionMode?: ClaudePermissionMode;
  workdir?: string;
} & SpawnDeps): Promise<{
  success: boolean;
  tmuxSession: string;
  sessionId: string;
  budgetMinutes: number;
  workdir: string;
  logFile: string;
  stateFile: string;
  error?: string;
}> {
  const sessionId = uuid();
  const logFile = path.join(tasksDir, `${tmuxSession}.log`);
  const stateFile = path.join(tasksDir, `${tmuxSession}.state`);

  try {
    // These values are interpolated into shell command strings (tmux
    // new-session and the watchdog bash script); reject anything that could
    // break out and inject commands.
    assertSafeTmuxSession(tmuxSession);
    assertSafeSessionId(sessionId);
    await exec(["tmux", "kill-session", "-t", tmuxSession], { timeoutMs: 5000 }).catch(() => {});
    await fs.rm(logFile, { force: true });
    await fs.rm(stateFile, { force: true });
    await fs.rm(`${stateFile}.watchdog`, { force: true });

    const permissionArgs =
      permissionMode === "bypassPermissions"
        ? " --permission-mode bypassPermissions"
        : "";

    await exec(
      [
        "tmux",
        "new-session",
        "-d",
        "-s",
        tmuxSession,
        "-c",
        workdir,
        `claude --session-id '${sessionId}'${permissionArgs}`,
      ],
      { timeoutMs: 10000 },
    );

    await exec(["tmux", "pipe-pane", "-t", tmuxSession, "-o", `cat >> '${logFile}'`], { timeoutMs: 5000 });

    if (sleepMs > 0) {
      await new Promise((r) => setTimeout(r, sleepMs));
    }

    const capture = await exec(["tmux", "capture-pane", "-t", tmuxSession, "-p"], { timeoutMs: 5000 });
    const stdout = capture.stdout ?? "";
    const trustThreeOption =
      /1\. Continue/i.test(stdout) &&
      /2\. Fix with Claude/i.test(stdout) &&
      /3\. Exit and fix manually/i.test(stdout) &&
      /Enter to confirm/i.test(stdout);
    const trustTwoOption =
      /Yes, I trust this folder/i.test(stdout) && /No, exit/i.test(stdout);
    if (trustThreeOption || trustTwoOption) {
      await exec(["tmux", "send-keys", "-t", tmuxSession, "1"], { timeoutMs: 5000 });
      await new Promise((r) => setTimeout(r, 1000));
      await exec(["tmux", "send-keys", "-t", tmuxSession, "Enter"], { timeoutMs: 5000 });
      await new Promise((r) => setTimeout(r, 2000));
    }

    const bufPath = path.join(tasksDir, `${tmuxSession}.taskbuf`);
    await fs.writeFile(bufPath, task, "utf8");
    await exec(["tmux", "load-buffer", "-b", "taskbuf", bufPath], { timeoutMs: 5000 });
    await exec(["tmux", "paste-buffer", "-b", "taskbuf", "-t", tmuxSession], { timeoutMs: 5000 });
    await exec(["tmux", "send-keys", "-t", tmuxSession, "Enter"], { timeoutMs: 5000 });
    await fs.rm(bufPath, { force: true });

    const stateLine = `RUNNING ${Date.now() / 1000 | 0} budget=${budgetMinutes}min workdir=${workdir} session_id=${sessionId}\n`;
    await writeState(stateFile, stateLine);

    await startWatchdog(stateFile, sessionId, tmuxSession, budgetMinutes);

    return {
      success: true,
      tmuxSession,
      sessionId,
      budgetMinutes,
      workdir,
      logFile,
      stateFile,
    };
  } catch (err) {
    return {
      success: false,
      tmuxSession,
      sessionId,
      budgetMinutes,
      workdir,
      logFile,
      stateFile,
      error: String(err),
    };
  }
}

export function createClaudeCodeSpawnTool(config?: {
  permissionMode?: ClaudePermissionMode;
}): AnyAgentTool {
  return {
    label: "Claude Code Spawn",
    name: "claude_code_spawn",
    description:
      "Spawn an interactive Claude Code session in a detached tmux session. Returns immediately.",
    parameters: Type.Object({
      tmuxSession: Type.String({ description: "Name for the tmux session" }),
      task: Type.String({ description: "Initial task to send to Claude Code" }),
      budgetMinutes: Type.Optional(Type.Number({ description: "Idle budget in minutes (default 30)" })),
      workdir: Type.Optional(Type.String({ description: "Working directory (default cwd)" })),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const { tmuxSession, task, budgetMinutes, workdir } = params as {
        tmuxSession: string;
        task: string;
        budgetMinutes?: number;
        workdir?: string;
      };
      const result = await spawnSession({
        tmuxSession,
        task,
        budgetMinutes,
        permissionMode: config?.permissionMode,
        workdir,
      });
      return jsonResult(result);
    },
  };
}

export async function handleSpawnRoute(
  body: unknown,
  config?: { permissionMode?: ClaudePermissionMode },
): Promise<{ status: number; body: unknown }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: 400, body: { error: "invalid body" } };
  }
  const { tmuxSession, task, budgetMinutes, workdir } = body as Record<string, unknown>;
  if (typeof tmuxSession !== "string" || typeof task !== "string") {
    return { status: 400, body: { error: "tmuxSession and task are required" } };
  }
  const result = await spawnSession({
    tmuxSession,
    task,
    budgetMinutes: typeof budgetMinutes === "number" ? budgetMinutes : undefined,
    permissionMode: config?.permissionMode,
    workdir: typeof workdir === "string" ? workdir : undefined,
  });
  return { status: result.success ? 200 : 500, body: result };
}
