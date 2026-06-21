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
