import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";

export type ExecFn = (
  argv: string[],
  optionsOrTimeout: number | { timeoutMs: number },
) => Promise<SpawnResult>;

// tmux session names and Claude Code session ids flow into shell command
// strings (tmux `new-session "<cmd>"`, watchdog `bash -c`). Restrict them to a
// safe character set so they cannot break out and inject arbitrary commands.
const SAFE_TMUX_SESSION = /^[A-Za-z0-9_-]+$/;
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

export function assertSafeTmuxSession(value: string): void {
  if (!SAFE_TMUX_SESSION.test(value)) {
    throw new Error(
      `unsafe tmux session name (allowed: letters, digits, '_', '-'): ${value}`,
    );
  }
}

export function assertSafeSessionId(value: string): void {
  if (!SAFE_SESSION_ID.test(value)) {
    throw new Error(
      `unsafe session id (allowed: letters, digits, '.', '_', '-'): ${value}`,
    );
  }
}

export async function sendKeysToTmuxSession({
  tmuxSession,
  text,
  submit,
  exec = runCommandWithTimeout,
}: {
  tmuxSession: string;
  text: string;
  submit: boolean;
  exec?: ExecFn;
}): Promise<void> {
  // literal mode (-l) still passes bytes through; reject escape/control sequences.
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) {
    throw new Error("tmux send-keys text contains control characters");
  }
  // `-l` sends every following argument literally, so "Enter" would be typed as
  // the 5-character string. Submit must be a separate send-keys call WITHOUT -l
  // so tmux interprets it as the Return key.
  const typed = await exec(
    ["tmux", "send-keys", "-t", tmuxSession, "-l", text],
    { timeoutMs: 5000 },
  );
  if (typed.code !== 0) {
    throw new Error(`tmux send-keys failed: ${typed.stderr}`);
  }
  if (submit) {
    const enter = await exec(
      ["tmux", "send-keys", "-t", tmuxSession, "Enter"],
      { timeoutMs: 5000 },
    );
    if (enter.code !== 0) {
      throw new Error(`tmux send-keys Enter failed: ${enter.stderr}`);
    }
  }
}

export async function tmuxSessionExists(
  tmuxSession: string,
  exec: ExecFn = runCommandWithTimeout,
): Promise<boolean> {
  const result = await exec(["tmux", "has-session", "-t", tmuxSession], { timeoutMs: 2000 });
  return result.code === 0;
}
