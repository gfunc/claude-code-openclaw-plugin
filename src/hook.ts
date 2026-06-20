import { z } from "zod";
import type { ClaudeCodeHookName, ClaudeCodeHookPayload } from "./state.js";

const hookNameSchema = z.enum([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "FileChanged",
  "CwdChanged",
]);

const hookPayloadSchema = z.object({
  hook_event_name: hookNameSchema,
  session_id: z.string().min(1),
  cwd: z.string().optional(),
  transcript_path: z.string().optional(),
  permission_mode: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
}).passthrough();

export type RawHookPayload = z.infer<typeof hookPayloadSchema>;

export function parseHookPayload(raw: unknown): RawHookPayload {
  return hookPayloadSchema.parse(raw);
}
