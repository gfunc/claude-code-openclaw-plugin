import type { ClaudeCodeState } from "./config.js";

export type ClaudeCodeBehavior = {
  state: ClaudeCodeState;
  wake: boolean;
  prompt: boolean;
  announce: boolean;
  prefix: string;
  message: string;
  oneShotAnnounce?: boolean;
};

export const STATE_BEHAVIOR: Record<ClaudeCodeState, ClaudeCodeBehavior> = {
  WORKING: { state: "WORKING", wake: false, prompt: false, announce: false, prefix: "", message: "" },
  WAITING: { state: "WAITING", wake: true, prompt: true, announce: true, prefix: "⚠️", message: "waiting for input" },
  QUESTION: { state: "QUESTION", wake: true, prompt: true, announce: true, prefix: "⚠️", message: "waiting for an answer" },
  PERMISSION: { state: "PERMISSION", wake: true, prompt: true, announce: false, prefix: "⚠️", message: "waiting for permission" },
  ERROR: { state: "ERROR", wake: true, prompt: true, announce: true, prefix: "🚨", message: "failed" },
  DONE: { state: "DONE", wake: true, prompt: true, announce: true, prefix: "ℹ️", message: "finished" },
  FATAL: { state: "FATAL", wake: false, prompt: true, announce: true, prefix: "🚨", message: "timed out", oneShotAnnounce: true },
};

export function resolveBehavior(
  state: ClaudeCodeState,
  notifyStates: ClaudeCodeState[],
): ClaudeCodeBehavior {
  const base = STATE_BEHAVIOR[state];
  if (!notifyStates.includes(state)) {
    return { ...base, wake: false, prompt: false, announce: false };
  }
  return base;
}
