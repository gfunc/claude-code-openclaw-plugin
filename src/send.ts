import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { sendKeysSequence, sendKeysToTmuxSession, tmuxSessionExists } from "./tmux.js";

export async function sendToSession({
  tmuxSession,
  text,
  submit = true,
  keys,
}: {
  tmuxSession: string;
  text?: string;
  submit?: boolean;
  keys?: string[];
}): Promise<{
  success: boolean;
  tmuxSession: string;
  submitted?: boolean;
  keysSent?: number;
  error?: string;
}> {
  const hasText = typeof text === "string" && text.length > 0;
  const hasKeys = Array.isArray(keys) && keys.length > 0;
  if (!hasText && !hasKeys) {
    return { success: false, tmuxSession, error: "text or keys is required" };
  }
  const exists = await tmuxSessionExists(tmuxSession);
  if (!exists) {
    return { success: false, tmuxSession, error: `tmux session ${tmuxSession} not found` };
  }
  try {
    if (hasText) {
      await sendKeysToTmuxSession({ tmuxSession, text: text as string, submit });
    }
    if (hasKeys) {
      await sendKeysSequence({ tmuxSession, keys: keys as string[] });
    }
    return {
      success: true,
      tmuxSession,
      submitted: hasText ? submit : undefined,
      keysSent: hasKeys ? (keys as string[]).length : 0,
    };
  } catch (err) {
    return { success: false, tmuxSession, error: String(err) };
  }
}

export function createClaudeCodeSendTool(_config?: unknown): AnyAgentTool {
  return {
    label: "Claude Code Send",
    name: "claude_code_send",
    description:
      "Send input into a running Claude Code tmux session. Use `text` to type a literal answer (submits with Enter by default). Use `keys` to drive arrow-highlight menus or special keys, e.g. [\"Down\",\"Down\",\"Enter\"] or [\"Escape\"]. Allowed keys: Up/Down/Left/Right/Enter/Escape/Tab/BTab/Space/Home/End/PageUp/PageDown/BSpace/Delete and single digits. Read the pane first with claude_code_read to see the options.",
    parameters: Type.Object({
      tmuxSession: Type.String({ description: "Tmux session name to send to" }),
      text: Type.Optional(
        Type.String({ description: "Literal text to type (e.g. an answer, or 'continue')" }),
      ),
      submit: Type.Optional(
        Type.Boolean({ description: "Press Enter after typing text to submit (default true)" }),
      ),
      keys: Type.Optional(
        Type.Array(Type.String(), {
          description: "Ordered special keys to press, e.g. [\"Down\",\"Enter\"].",
        }),
      ),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const { tmuxSession, text, submit, keys } = params as {
        tmuxSession: string;
        text?: string;
        submit?: boolean;
        keys?: string[];
      };
      const result = await sendToSession({
        tmuxSession,
        text,
        submit: submit !== false,
        keys,
      });
      return jsonResult(result);
    },
  };
}

export async function handleSendRoute(body: unknown): Promise<{ status: number; body: unknown }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: 400, body: { error: "invalid body" } };
  }
  const { tmuxSession, text, submit, keys } = body as Record<string, unknown>;
  if (typeof tmuxSession !== "string") {
    return { status: 400, body: { error: "tmuxSession is required" } };
  }
  const normalizedKeys = Array.isArray(keys)
    ? keys.filter((k): k is string => typeof k === "string")
    : undefined;
  const result = await sendToSession({
    tmuxSession,
    text: typeof text === "string" ? text : undefined,
    submit: typeof submit === "boolean" ? submit : true,
    keys: normalizedKeys,
  });
  return { status: result.success ? 200 : 404, body: result };
}
