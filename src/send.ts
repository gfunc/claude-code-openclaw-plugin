import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { sendKeysToTmuxSession, tmuxSessionExists } from "./tmux.js";

export async function sendToSession({
  tmuxSession,
  text,
  submit = true,
}: {
  tmuxSession: string;
  text: string;
  submit?: boolean;
}): Promise<{ success: boolean; tmuxSession: string; submitted?: boolean; error?: string }> {
  const exists = await tmuxSessionExists(tmuxSession);
  if (!exists) {
    return { success: false, tmuxSession, error: `tmux session ${tmuxSession} not found` };
  }
  try {
    await sendKeysToTmuxSession({ tmuxSession, text, submit });
    return { success: true, tmuxSession, submitted: submit };
  } catch (err) {
    return { success: false, tmuxSession, error: String(err) };
  }
}

export function createClaudeCodeSendTool(_config?: unknown): AnyAgentTool {
  return {
    label: "Claude Code Send",
    name: "claude_code_send",
    description:
      "Send text into a running Claude Code tmux session: answer a question, approve, or tell it to continue. Defaults to pressing Enter (submit) so the input is delivered. Set submit=false to type without submitting.",
    parameters: Type.Object({
      tmuxSession: Type.String({ description: "Tmux session name to send to" }),
      text: Type.String({ description: "Text to type into the session (e.g. an answer, or 'continue')" }),
      submit: Type.Optional(
        Type.Boolean({ description: "Press Enter after typing to submit (default true)" }),
      ),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const { tmuxSession, text, submit } = params as {
        tmuxSession: string;
        text: string;
        submit?: boolean;
      };
      const result = await sendToSession({ tmuxSession, text, submit: submit !== false });
      return jsonResult(result);
    },
  };
}

export async function handleSendRoute(body: unknown): Promise<{ status: number; body: unknown }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: 400, body: { error: "invalid body" } };
  }
  const { tmuxSession, text, submit } = body as Record<string, unknown>;
  if (typeof tmuxSession !== "string" || typeof text !== "string") {
    return { status: 400, body: { error: "tmuxSession and text are required" } };
  }
  const result = await sendToSession({
    tmuxSession,
    text,
    submit: typeof submit === "boolean" ? submit : true,
  });
  return { status: result.success ? 200 : 404, body: result };
}
