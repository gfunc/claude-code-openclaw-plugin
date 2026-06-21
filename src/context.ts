import { resolveBehavior } from "./behavior.js";
import type { ClaudeCodeState } from "./config.js";
import type { SessionState } from "./state.js";

const STATE_ORDER: Record<ClaudeCodeState, number> = {
  FATAL: 0,
  ERROR: 1,
  PERMISSION: 2,
  QUESTION: 3,
  WAITING: 4,
  DONE: 5,
  WORKING: 6,
};

export function buildClaudeCodeContext({
  sessions,
  notifyStates,
}: {
  sessions: SessionState[];
  notifyStates?: ClaudeCodeState[];
}): string {
  const allStates = Object.keys(STATE_ORDER) as ClaudeCodeState[];
  const relevant = sessions
    .filter((s) => {
      const behavior = resolveBehavior(s.state, notifyStates ?? allStates);
      return behavior.prompt;
    })
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);

  if (relevant.length === 0) return "";

  const lines = ["## Active Claude Code sessions"];
  for (const s of relevant) {
    const behavior = resolveBehavior(s.state, notifyStates ?? allStates);
    lines.push(
      `- ${behavior.prefix} tmux: ${s.tmuxSession ?? "unknown"} | state: ${s.state} | ${behavior.message}`,
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
