import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export type SetupAgentConfig = {
  configPath?: string; // override for tests; defaults to ~/.openclaw/openclaw.json
};

const DEFAULT_AGENT_ID = "cc-watcher";
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");

type SetupAgentResult = {
  success: boolean;
  configPath: string;
  agentId: string;
  alreadyConfigured?: boolean;
  added?: boolean;
  error?: string;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function setupAgent({
  configPath,
  agentId,
  model,
}: {
  configPath?: string;
  agentId?: string;
  model?: { primary?: string; fallbacks?: string[] };
}): Promise<SetupAgentResult> {
  const targetPath = configPath ?? DEFAULT_CONFIG_PATH;
  const id = agentId ?? DEFAULT_AGENT_ID;

  if (!id.trim()) {
    return {
      success: false,
      configPath: targetPath,
      agentId: id,
      error: "agentId must not be empty",
    };
  }

  let raw: string;
  try {
    raw = await fs.readFile(targetPath, "utf8");
  } catch (err) {
    return {
      success: false,
      configPath: targetPath,
      agentId: id,
      error: `cannot read OpenClaw config: ${targetPath} — ${String((err as Error).message ?? err)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      success: false,
      configPath: targetPath,
      agentId: id,
      error: `OpenClaw config is not valid JSON: ${String(err)}`,
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      success: false,
      configPath: targetPath,
      agentId: id,
      error: `OpenClaw config root is not a JSON object`,
    };
  }

  // Resolve agents block. Refuse to overwrite a non-object value.
  let agents: Record<string, unknown>;
  if (parsed.agents === undefined) {
    agents = {};
    parsed.agents = agents;
  } else if (isPlainObject(parsed.agents)) {
    agents = parsed.agents;
  } else {
    return {
      success: false,
      configPath: targetPath,
      agentId: id,
      error: `OpenClaw config 'agents' is present but not an object; refusing to overwrite`,
    };
  }

  // Resolve agents.list. Refuse to overwrite a non-array value.
  let list: Array<unknown>;
  if (agents.list === undefined) {
    list = [];
    agents.list = list;
  } else if (Array.isArray(agents.list)) {
    list = agents.list;
  } else {
    return {
      success: false,
      configPath: targetPath,
      agentId: id,
      error: `OpenClaw config 'agents.list' is present but not an array; refusing to overwrite`,
    };
  }

  // Check if agent already exists.
  if (list.some((a) => isPlainObject(a) && a.id === id)) {
    return {
      success: true,
      configPath: targetPath,
      agentId: id,
      alreadyConfigured: true,
    };
  }

  // Build the new agent entry. Model is optional — if omitted, the agent
  // inherits from agents.defaults.model.
  const entry: Record<string, unknown> = { id };
  if (model && (model.primary || (model.fallbacks && model.fallbacks.length))) {
    const m: Record<string, unknown> = {};
    if (model.primary) m.primary = model.primary;
    if (model.fallbacks && model.fallbacks.length) m.fallbacks = model.fallbacks;
    entry.model = m;
  }
  list.push(entry);

  // Pretty-print with 2-space indent (matches existing OpenClaw config style).
  try {
    await fs.writeFile(targetPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  } catch (err) {
    return {
      success: false,
      configPath: targetPath,
      agentId: id,
      error: `failed to write OpenClaw config: ${String((err as Error).message ?? err)}`,
    };
  }

  return {
    success: true,
    configPath: targetPath,
    agentId: id,
    added: true,
  };
}

export function createClaudeCodeSetupAgentTool(config?: SetupAgentConfig): AnyAgentTool {
  return {
    label: "Claude Code Setup Watcher Agent",
    name: "claude_code_setup_agent",
    description:
      "Register a notification watcher agent (default id: cc-watcher) in ~/.openclaw/openclaw.json so the Claude Code plugin can deliver completion notifications. Idempotent.",
    parameters: Type.Object({
      agentId: Type.Optional(Type.String({ description: "Agent id to register (default: cc-watcher)" })),
      primaryModel: Type.Optional(Type.String({ description: "Primary model id; omit to inherit from agents.defaults" })),
      fallbackModels: Type.Optional(
        Type.Array(Type.String(), { description: "Fallback model ids in priority order" }),
      ),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const p = params as { agentId?: string; primaryModel?: string; fallbackModels?: string[] };
      const result = await setupAgent({
        configPath: config?.configPath,
        agentId: p.agentId,
        model:
          p.primaryModel || (p.fallbackModels && p.fallbackModels.length)
            ? { primary: p.primaryModel, fallbacks: p.fallbackModels }
            : undefined,
      });
      return jsonResult(result);
    },
  };
}