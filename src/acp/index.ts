import os from "node:os";
import path from "node:path";
import { registerAcpRuntimeBackend } from "openclaw/plugin-sdk/acp-runtime";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import type { PluginConfig } from "../config.js";
import type { SessionStore } from "../store.js";
import { createAcpSessionManager } from "./session-manager.js";
import { createAcpTmuxRuntime } from "./tmux-runtime.js";
import { createAcpEventStreamer } from "./event-streamer.js";
import { createClaudeCodeAcpRuntime } from "./claude-code-acp-runtime.js";

export type { AcpEventStreamer } from "./event-streamer.js";

export function registerClaudeCodeAcpBackend(params: {
  config: PluginConfig;
  store: SessionStore;
  log: (text: string) => void;
}): {
  eventStreamer: ReturnType<typeof createAcpEventStreamer>;
} {
  const exec = runCommandWithTimeout;
  const sessionManager = createAcpSessionManager({
    exec,
    stateFileDir: params.config.stateFileDir,
    tasksDir: path.join(os.homedir(), ".cache", "claude-tasks"),
    log: params.log,
    permissionMode: params.config.acpPermissionMode,
    budgetMinutes: params.config.acpBudgetMinutes,
    allowedTools: params.config.acpAllowedTools,
  });
  const tmuxRuntime = createAcpTmuxRuntime(exec);
  const eventStreamer = createAcpEventStreamer(params.store);
  const runtime = createClaudeCodeAcpRuntime({
    sessionManager,
    tmuxRuntime,
    eventStreamer,
    store: params.store,
    exec,
    log: params.log,
  });
  registerAcpRuntimeBackend({ id: params.config.acpBackendId, runtime });
  return { eventStreamer };
}
