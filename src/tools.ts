import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import type { SessionStore } from "./store.js";

export function createClaudeCodeStatusTool(store: SessionStore): AnyAgentTool {
  return {
    label: "Claude Code Status",
    name: "claude_code_status",
    description:
      "List active Claude Code sessions tracked by the hook plugin. Returns session id, tmux session, state, and log file path.",
    parameters: Type.Object({
      state: Type.Optional(
        Type.String({ description: "Filter by state, e.g. WAITING or ERROR" }),
      ),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const { state } = params as { state?: string };
      let sessions = store.listStates();
      if (state) {
        sessions = sessions.filter((s) => s.state === state);
      }
      return jsonResult({
        sessions: sessions.map((s) => ({
          sessionId: s.sessionId,
          tmuxSession: s.tmuxSession,
          state: s.state,
          lastHookEvent: s.lastHookEvent,
          lastSeenAt: s.lastSeenAt,
          logFile: s.logFile,
          workdir: s.workdir,
        })),
      });
    },
  };
}
