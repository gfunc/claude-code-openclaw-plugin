import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import fs from "node:fs/promises";
import path from "node:path";

export type SetupHooksConfig = {
  templatePath?: string;
};

const HOOK_URL = "http://127.0.0.1:18789/claude-code/hook";

// Hook events the plugin tracks. Kept in code (not an external template file)
// so setup works regardless of where the plugin is installed from (npm,
// node_modules, a clone in any directory, etc).
const HOOK_EVENTS = [
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
  "Elicitation",
  "ElicitationResult",
] as const;

function buildHookSettings(): string {
  const hookEntry = {
    matcher: "*",
    hooks: [{ type: "http", url: HOOK_URL, timeout: 30 }],
  };
  const hooks = Object.fromEntries(HOOK_EVENTS.map((event) => [event, [hookEntry]]));
  return JSON.stringify({ hooks }, null, 2) + "\n";
}

export async function setupHooks({
  repoPath,
  shared,
  force,
  templatePath,
}: {
  repoPath: string;
  shared?: boolean;
  force?: boolean;
  templatePath?: string;
}): Promise<{ success: boolean; target?: string; alreadyConfigured?: boolean; error?: string }> {
  const absRepo = path.resolve(repoPath);
  try {
    await fs.access(absRepo);
  } catch {
    return { success: false, error: `not a directory: ${absRepo}` };
  }

  for (const f of [
    path.join(absRepo, ".claude", "settings.json"),
    path.join(absRepo, ".claude", "settings.local.json"),
  ]) {
    try {
      const content = await fs.readFile(f, "utf8");
      if (content.includes(HOOK_URL)) {
        return { success: true, target: f, alreadyConfigured: true };
      }
    } catch {
      // file does not exist
    }
  }

  const target = shared
    ? path.join(absRepo, ".claude", "settings.json")
    : path.join(absRepo, ".claude", "settings.local.json");

  if (!force) {
    try {
      await fs.access(target);
      return {
        success: false,
        error: `${target} exists but does not contain hook URL; use --force to overwrite`,
      };
    } catch {
      // target does not exist
    }
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  if (templatePath) {
    await fs.copyFile(templatePath, target);
  } else {
    await fs.writeFile(target, buildHookSettings(), "utf8");
  }
  return { success: true, target };
}

export function createClaudeCodeSetupHooksTool(config?: SetupHooksConfig): AnyAgentTool {
  return {
    label: "Claude Code Setup Hooks",
    name: "claude_code_setup_hooks",
    description:
      "Install Claude Code hook settings in a target repository so the OpenClaw plugin can track sessions. Writes .claude/settings.local.json by default; use shared=true for .claude/settings.json.",
    parameters: Type.Object({
      repoPath: Type.String({ description: "Path to the target repository" }),
      shared: Type.Optional(Type.Boolean({ description: "Write to .claude/settings.json instead of .local.json" })),
      force: Type.Optional(Type.Boolean({ description: "Overwrite existing settings file" })),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const { repoPath, shared, force } = params as { repoPath: string; shared?: boolean; force?: boolean };
      const result = await setupHooks({ repoPath, shared, force, templatePath: config?.templatePath });
      return jsonResult(result);
    },
  };
}

export async function handleSetupHooksRoute(
  body: unknown,
  config?: SetupHooksConfig,
): Promise<{ status: number; body: unknown }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: 400, body: { error: "invalid body" } };
  }
  const { repoPath, shared, force } = body as Record<string, unknown>;
  if (typeof repoPath !== "string") {
    return { status: 400, body: { error: "repoPath is required" } };
  }
  const result = await setupHooks({
    repoPath,
    shared: Boolean(shared),
    force: Boolean(force),
    templatePath: config?.templatePath,
  });
  return { status: result.success ? 200 : 409, body: result };
}
