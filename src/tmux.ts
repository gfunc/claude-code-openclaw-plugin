import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";

export type ExecFn = (
  argv: string[],
  optionsOrTimeout: number | { timeoutMs: number },
) => Promise<SpawnResult>;

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
  const args = ["tmux", "send-keys", "-t", tmuxSession, "-l", text];
  if (submit) {
    args.push("Enter");
  }
  const result = await exec(args, { timeoutMs: 5000 });
  if (result.code !== 0) {
    throw new Error(`tmux send-keys failed: ${result.stderr}`);
  }
}

export async function tmuxSessionExists(
  tmuxSession: string,
  exec: ExecFn = runCommandWithTimeout,
): Promise<boolean> {
  const result = await exec(["tmux", "has-session", "-t", tmuxSession], { timeoutMs: 2000 });
  return result.code === 0;
}
