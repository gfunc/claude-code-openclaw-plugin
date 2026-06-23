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

// tmux named keys safe to forward for menu navigation. Anything outside this set
// (or a single digit) is rejected so callers cannot smuggle arbitrary key specs.
const ALLOWED_KEY_NAMES = new Set([
  "Up",
  "Down",
  "Left",
  "Right",
  "Enter",
  "Escape",
  "Tab",
  "BTab",
  "Space",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "BSpace",
  "Delete",
]);

export function assertSafeKeys(keys: string[]): void {
  for (const key of keys) {
    if (!ALLOWED_KEY_NAMES.has(key) && !/^[0-9]$/.test(key)) {
      throw new Error(`unsupported tmux key: ${key}`);
    }
  }
}

// Sends named keys (arrows, Enter, Escape, digits, ...) WITHOUT `-l` so tmux
// interprets them as keypresses. Used to drive arrow-highlight menus that don't
// accept typed answers.
export async function sendKeysSequence({
  tmuxSession,
  keys,
  exec = runCommandWithTimeout,
}: {
  tmuxSession: string;
  keys: string[];
  exec?: ExecFn;
}): Promise<void> {
  if (keys.length === 0) return;
  assertSafeKeys(keys);
  const result = await exec(
    ["tmux", "send-keys", "-t", tmuxSession, ...keys],
    { timeoutMs: 5000 },
  );
  if (result.code !== 0) {
    throw new Error(`tmux send-keys failed: ${result.stderr}`);
  }
}

// Captures the current pane contents. `lines` extends capture into scrollback so
// the caller can read more than the visible viewport.
export async function capturePane({
  tmuxSession,
  lines,
  exec = runCommandWithTimeout,
}: {
  tmuxSession: string;
  lines?: number;
  exec?: ExecFn;
}): Promise<string> {
  const argv = ["tmux", "capture-pane", "-t", tmuxSession, "-p"];
  if (typeof lines === "number" && lines > 0) {
    argv.push("-S", `-${Math.floor(lines)}`);
  }
  const result = await exec(argv, { timeoutMs: 5000 });
  if (result.code !== 0) {
    throw new Error(`tmux capture-pane failed: ${result.stderr}`);
  }
  return result.stdout ?? "";
}
