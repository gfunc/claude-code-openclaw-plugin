import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { capturePane, tmuxSessionExists } from "./tmux.js";

export async function readSession({
  tmuxSession,
  lines,
}: {
  tmuxSession: string;
  lines?: number;
}): Promise<{ success: boolean; tmuxSession: string; output?: string; error?: string }> {
  const exists = await tmuxSessionExists(tmuxSession);
  if (!exists) {
    return { success: false, tmuxSession, error: `tmux session ${tmuxSession} not found` };
  }
  try {
    const output = await capturePane({ tmuxSession, lines });
    return { success: true, tmuxSession, output };
  } catch (err) {
    return { success: false, tmuxSession, error: String(err) };
  }
}

export function createClaudeCodeReadTool(_config?: unknown): AnyAgentTool {
  return {
    label: "Claude Code Read",
    name: "claude_code_read",
    description:
      "Read the current Claude Code tmux pane so you can see the live prompt, menu options, or result before answering. Pair with claude_code_send to act on what you read.",
    parameters: Type.Object({
      tmuxSession: Type.String({ description: "Tmux session name to read" }),
      lines: Type.Optional(
        Type.Number({ description: "Include this many scrollback lines above the visible pane" }),
      ),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const { tmuxSession, lines } = params as { tmuxSession: string; lines?: number };
      const result = await readSession({ tmuxSession, lines });
      return jsonResult(result);
    },
  };
}

export async function handleReadRoute(body: unknown): Promise<{ status: number; body: unknown }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: 400, body: { error: "invalid body" } };
  }
  const { tmuxSession, lines } = body as Record<string, unknown>;
  if (typeof tmuxSession !== "string") {
    return { status: 400, body: { error: "tmuxSession is required" } };
  }
  const result = await readSession({
    tmuxSession,
    lines: typeof lines === "number" ? lines : undefined,
  });
  return { status: result.success ? 200 : 404, body: result };
}
