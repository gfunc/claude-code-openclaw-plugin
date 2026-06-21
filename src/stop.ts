import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import type { ExecFn } from "./tmux.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export type StopDeps = {
  exec?: ExecFn;
  tasksDir?: string;
  writeState?: (statePath: string, line: string) => Promise<void>;
  killWatchdog?: (statePath: string) => Promise<void>;
};

const DEFAULT_TASKS_DIR = path.join(os.homedir(), ".cache", "claude-tasks");

export async function stopSession({
  sessionName,
  exec = runCommandWithTimeout,
  tasksDir = DEFAULT_TASKS_DIR,
  writeState = defaultWriteState,
  killWatchdog = defaultKillWatchdog,
}: {
  sessionName: string;
} & StopDeps): Promise<{ success: boolean; sessionName: string; stopped?: boolean; error?: string }> {
  const statePath = path.join(tasksDir, `${sessionName}.state`);
  await killWatchdog(statePath);

  const hasSession = await exec(["tmux", "has-session", "-t", sessionName], { timeoutMs: 2000 });
  if (hasSession.code !== 0) {
    return { success: false, sessionName, error: `session not alive: ${sessionName}` };
  }

  await exec(["tmux", "kill-session", "-t", sessionName], { timeoutMs: 5000 });
  await writeState(statePath, `STOPPED ${Date.now() / 1000 | 0}\n`);
  return { success: true, sessionName, stopped: true };
}

async function defaultWriteState(statePath: string, line: string): Promise<void> {
  await fs.appendFile(statePath, line, "utf8").catch(() => {});
}

async function defaultKillWatchdog(statePath: string): Promise<void> {
  const watchdogPath = `${statePath}.watchdog`;
  try {
    const pid = await fs.readFile(watchdogPath, "utf8");
    if (pid.trim()) {
      try {
        process.kill(Number(pid.trim()), "SIGTERM");
      } catch {
        // ignore
      }
    }
  } catch {
    // no watchdog file
  }
  await fs.unlink(watchdogPath).catch(() => {});
}

export function createClaudeCodeStopTool(_config?: unknown): AnyAgentTool {
  return {
    label: "Claude Code Stop",
    name: "claude_code_stop",
    description: "Stop a running Claude Code tmux session by its tmux session name.",
    parameters: Type.Object({
      sessionName: Type.String({ description: "Tmux session name to stop" }),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const { sessionName } = params as { sessionName: string };
      const result = await stopSession({ sessionName });
      return jsonResult(result);
    },
  };
}

export async function handleStopRoute(
  body: unknown,
  _config?: unknown,
): Promise<{ status: number; body: unknown }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: 400, body: { error: "invalid body" } };
  }
  const { sessionName } = body as Record<string, unknown>;
  if (typeof sessionName !== "string") {
    return { status: 400, body: { error: "sessionName is required" } };
  }
  const result = await stopSession({ sessionName });
  return { status: result.success ? 200 : 404, body: result };
}
