import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const ClaudeCodeState = z.enum([
  "WORKING",
  "WAITING",
  "QUESTION",
  "PERMISSION",
  "ERROR",
  "DONE",
  "FATAL",
]);

export type ClaudeCodeState = z.infer<typeof ClaudeCodeState>;

// Mirrors Claude Code's CLI `--permission-mode` values.
export const ClaudePermissionMode = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]);
export type ClaudePermissionMode = z.infer<typeof ClaudePermissionMode>;

export const pluginConfigSchema = z.object({
  routePrefix: z.string().default("/claude-code"),
  eventTypes: z.array(z.string()).default(["*"]),
  stateFileDir: z.string().default("~/.cache/claude-code-hooks"),
  notifyStates: z.array(ClaudeCodeState).default([
    "WAITING",
    "QUESTION",
    "PERMISSION",
    "ERROR",
    "DONE",
  ]),
  sendKeysRateLimitPerMinute: z.number().int().positive().default(10),
  sessionTimeoutSeconds: z.number().int().positive().default(300),
  targetSessionKey: z.string().default("agent:main:main"),
  permissionMode: ClaudePermissionMode.default("bypassPermissions"),
  // Append a line per received hook to <stateFileDir>/<sessionId>.log.
  // Off by default; logs are not rotated.
  debugLog: z.boolean().default(false),
  // If set, POST completion notifications to this WeCom webhook URL.
  // Bypasses OpenClaw's internal heartbeat system for reliable delivery.
  wecomWebhookUrl: z.string().optional(),
});

export type PluginConfig = z.infer<typeof pluginConfigSchema>;

function expandTilde(input: string): string {
  if (input.startsWith("~")) {
    return path.join(os.homedir(), input.slice(1));
  }
  return input;
}

export function resolvePluginConfig(raw: unknown): PluginConfig {
  const parsed = pluginConfigSchema.parse(raw);
  return {
    ...parsed,
    stateFileDir: expandTilde(parsed.stateFileDir),
  };
}
