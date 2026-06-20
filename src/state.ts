import type { ClaudeCodeState } from "./config.js";

// NOTE: The ClaudeCodeState enum includes QUESTION and FATAL, but those are
// not produced by deriveState(). QUESTION is reserved for future OpenClaw
// classification, and FATAL is set externally by the timeout service.

export type ClaudeCodeHookName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "Stop"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PermissionRequest"
  | "FileChanged"
  | "CwdChanged";

export type ClaudeCodeHookPayload = {
  hook_event_name: ClaudeCodeHookName;
  session_id: string;
  cwd?: string;
  transcript_path?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: unknown;
  [key: string]: unknown;
};

export type SessionState = {
  sessionId: string;
  tmuxSession?: string;
  openclawSessionKey?: string;
  workdir?: string;
  logFile?: string;
  state: ClaudeCodeState;
  lastHookEvent: ClaudeCodeHookName;
  lastHookPayload: ClaudeCodeHookPayload;
  stateSince: number;
  lastSeenAt: number;
  budgetMinutes?: number;
  budgetDeadline?: number;
  fatalReason?: string;
  history: Array<{
    ts: number;
    state: ClaudeCodeState;
    event: ClaudeCodeHookName;
    tool?: string;
  }>;
};

export function deriveState(payload: ClaudeCodeHookPayload): {
  state: ClaudeCodeState;
  tool?: string;
} {
  switch (payload.hook_event_name) {
    case "SessionStart":
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
    case "FileChanged":
    case "CwdChanged":
      return { state: "WORKING", tool: payload.tool_name };
    case "PostToolUseFailure":
      return { state: "ERROR", tool: payload.tool_name };
    case "PermissionRequest":
      return { state: "PERMISSION" };
    case "SessionEnd":
      return { state: "DONE" };
    case "Stop":
    default:
      return { state: "WAITING" };
  }
}

export function buildInitialState(payload: ClaudeCodeHookPayload): SessionState {
  const now = Date.now();
  const { state, tool } = deriveState(payload);
  return {
    sessionId: payload.session_id,
    workdir: payload.cwd,
    state,
    lastHookEvent: payload.hook_event_name,
    lastHookPayload: { ...payload },
    stateSince: now,
    lastSeenAt: now,
    history: [{ ts: now, state, event: payload.hook_event_name, tool }],
  };
}

export function applyHook(
  current: SessionState,
  payload: ClaudeCodeHookPayload,
): SessionState {
  const now = Date.now();
  const { state, tool } = deriveState(payload);
  const isNewState = current.state !== state;
  return {
    ...current,
    workdir: payload.cwd ?? current.workdir,
    state,
    lastHookEvent: payload.hook_event_name,
    lastHookPayload: { ...payload },
    stateSince: isNewState ? now : current.stateSince,
    lastSeenAt: now,
    history: [
      ...current.history,
      { ts: now, state, event: payload.hook_event_name, tool },
    ],
  };
}
