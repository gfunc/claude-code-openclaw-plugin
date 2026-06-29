import type { ClaudePermissionMode } from "../config.js";
import type { ExecFn } from "../tmux.js";

export type AcpSessionSidecar = {
  /** OpenClaw ACP session key (the id returned by sessions_spawn). */
  sessionKey: string;
  /** tmux session name that hosts the running claude process, e.g. cc-a1b2c3d4. */
  tmuxSessionName: string;
  /** Claude Code --session-id; used for claude --resume. */
  claudeCodeSessionId: string;
  cwd: string;
  mode: "oneshot" | "persistent";
  startedAt: number;
  permissionMode: ClaudePermissionMode;
  budgetMinutes: number;
};

export type AcpRuntimeDeps = {
  exec: ExecFn;
  stateFileDir: string;
  tasksDir: string;
  log: (text: string) => void;
  permissionMode: ClaudePermissionMode;
  budgetMinutes: number;
  allowedTools: string[];
};

export type AcpTurnContext = {
  sessionKey: string;
  requestId: string;
  aborted: boolean;
};
