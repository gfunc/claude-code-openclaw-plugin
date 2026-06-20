import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { SessionStore } from "./store.js";

export function createClaudeCodeStatusTool(store: SessionStore): AnyAgentTool {
  return {
    name: "claude_code_status",
    description:
      "List active Claude Code sessions tracked by the hook plugin. Returns session id, tmux session, state, and log file path.",
    parameters: Type.Object({
      state: Type.Optional(
        Type.String({ description: "Filter by state, e.g. WAITING or ERROR" }),
      ),
    }),
    async execute(params: { state?: string }) {
      let sessions = store.listStates();
      if (params.state) {
        sessions = sessions.filter((s) => s.state === params.state);
      }
      return {
        sessions: sessions.map((s) => ({
          sessionId: s.sessionId,
          tmuxSession: s.tmuxSession,
          state: s.state,
          lastHookEvent: s.lastHookEvent,
          lastSeenAt: s.lastSeenAt,
          logFile: s.logFile,
          workdir: s.workdir,
        })),
      };
    },
  };
}
