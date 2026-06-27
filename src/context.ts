import type { ClaudeCodeState } from "./config.js";
import type { SessionState } from "./state.js";

const STATE_LABELS: Record<
  ClaudeCodeState,
  { prompt: boolean; prefix: string; message: string }
> = {
  WORKING: { prompt: false, prefix: "", message: "" },
  WAITING: { prompt: true, prefix: "⚠️", message: "waiting for input" },
  QUESTION: { prompt: true, prefix: "⚠️", message: "waiting for an answer" },
  PERMISSION: { prompt: true, prefix: "⚠️", message: "waiting for permission" },
  ERROR: { prompt: true, prefix: "🚨", message: "failed" },
  DONE: { prompt: true, prefix: "ℹ️", message: "finished" },
  FATAL: { prompt: true, prefix: "🚨", message: "timed out" },
};

const STATE_ORDER: Record<ClaudeCodeState, number> = {
  FATAL: 0, ERROR: 1, PERMISSION: 2, QUESTION: 3, WAITING: 4, DONE: 5, WORKING: 6,
};

export function buildClaudeCodeContext({
  sessions,
}: {
  sessions: SessionState[];
}): string {
  const relevant = sessions
    .filter((s) => STATE_LABELS[s.state].prompt)
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);

  if (relevant.length === 0) return "";

  const lines = ["## Active Claude Code sessions"];
  for (const s of relevant) {
    const display = STATE_LABELS[s.state];
    lines.push(
      `- ${display.prefix} tmux: ${s.tmuxSession ?? "unknown"} | state: ${s.state} | ${display.message}`,
    );
    lines.push(`  since: ${new Date(s.stateSince).toISOString()}`);
    if (s.workdir) lines.push(`  workdir: ${s.workdir}`);
    if (s.fatalReason) lines.push(`  reason: ${s.fatalReason}`);
    if (s.budgetDeadline)
      lines.push(`  budget deadline: ${new Date(s.budgetDeadline).toISOString()}`);
    if (s.logFile) lines.push(`  log: ${s.logFile}`);
  }
  lines.push("");
  return lines.join("\n");
}
