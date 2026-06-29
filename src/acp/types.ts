import type { ClaudePermissionMode } from "../config.js";
import type { ExecFn } from "../tmux.js";

export type AcpSessionSidecar = {
  sessionKey: string;
  tmuxSession: string;
  sessionId: string;
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
