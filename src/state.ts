import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { ClaudeCodeState } from "./config.js";

// Re-export so other plugin modules can use the same SDK-derived type
// without each having to repeat the indexed-access dance.
export type DeliveryContext = NonNullable<OpenClawPluginToolContext["deliveryContext"]>;

// FATAL is set externally by the timeout service, not derived from hooks.
// QUESTION is not produced by any current hook; skipped until a real trigger exists.

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
  | "CwdChanged"
  | "Elicitation"
  | "ElicitationResult";

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
  // notification routing — captured at spawn from tool factory ctx
  runId?: string;
  notifySessionKey?: string;
  notifyDeliveryContext?: DeliveryContext;
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
    case "Elicitation":
      return { state: "QUESTION" };
    case "ElicitationResult":
      // user answered a question — back to working
      return { state: "WORKING" };
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
