import type { ClaudeCodeState } from "./config.js";

export type ClaudeCodeBehavior = {
  state: ClaudeCodeState;
  prompt: boolean;
  announce: boolean;
  prefix: string;
  message: string;
  oneShotAnnounce?: boolean;
};

export const STATE_BEHAVIOR: Record<ClaudeCodeState, ClaudeCodeBehavior> = {
  WORKING: { state: "WORKING", prompt: false, announce: false, prefix: "", message: "" },
  WAITING: { state: "WAITING", prompt: true, announce: true, prefix: "⚠️", message: "waiting for input" },
  QUESTION: { state: "QUESTION", prompt: true, announce: true, prefix: "⚠️", message: "waiting for an answer" },
  PERMISSION: { state: "PERMISSION", prompt: true, announce: false, prefix: "⚠️", message: "waiting for permission" },
  ERROR: { state: "ERROR", prompt: true, announce: true, prefix: "🚨", message: "failed" },
  DONE: { state: "DONE", prompt: true, announce: true, prefix: "ℹ️", message: "finished" },
  FATAL: { state: "FATAL", prompt: true, announce: true, prefix: "🚨", message: "timed out", oneShotAnnounce: true },
};

export function resolveBehavior(
  state: ClaudeCodeState,
  notifyStates: ClaudeCodeState[],
): ClaudeCodeBehavior {
  const base = STATE_BEHAVIOR[state];
  if (!notifyStates.includes(state)) {
    return { ...base, prompt: false, announce: false };
  }
  return base;
}
