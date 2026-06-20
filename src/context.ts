import type { ClaudeCodeState } from "./config.js";
import type { SessionState } from "./state.js";

// Builds a context snippet for OpenClaw agents.
// Currently reserved for future SDK support of the `before_prompt_build` hook;
// the active OpenClaw SDK build no longer exposes `api.on(...)`, so this helper
// is not wired in src/index.ts, but it remains tested and spec-aligned.
export function buildClaudeCodeContext({
  sessions,
  notifyStates,
}: {
  sessions: SessionState[];
  notifyStates: ClaudeCodeState[];
}): string {
  const relevant = sessions.filter((s) => notifyStates.includes(s.state));
  if (relevant.length === 0) return "";
  const lines = ["## Active Claude Code sessions"];
  for (const s of relevant) {
    lines.push(`- tmux: ${s.tmuxSession ?? "unknown"} | state: ${s.state} | since: ${new Date(s.stateSince).toISOString()}`);
    if (s.workdir) lines.push(`  workdir: ${s.workdir}`);
    if (s.budgetDeadline) lines.push(`  budget deadline: ${new Date(s.budgetDeadline).toISOString()}`);
    if (s.logFile) lines.push(`  log: ${s.logFile}`);
  }
  lines.push("");
  return lines.join("\n");
}
