import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolvePluginConfig } from "./config.js";
import { discoverSession } from "./discovery.js";
import { createSessionEventLogger } from "./event-log.js";
import { createClaudeCodeRoutes } from "./routes.js";
import { createSessionStore } from "./store.js";
import { createClaudeCodeSetupHooksTool } from "./setup-hooks.js";
import { registerClaudeCodeAcpBackend } from "./acp/index.js";

const pluginConfigJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    routePrefix: { type: "string", default: "/claude-code" },
    eventTypes: {
      type: "array",
      items: { type: "string" },
      default: ["*"],
    },
    stateFileDir: { type: "string", default: "~/.cache/claude-code-hooks" },
    sessionTimeoutSeconds: { type: "number", default: 300 },
    debugLog: { type: "boolean", default: false },
    acpBudgetMinutes: { type: "number", default: 30 },
    acpPermissionMode: {
      type: "string",
      enum: ["default", "acceptEdits", "plan", "bypassPermissions"],
      default: "bypassPermissions",
    },
    acpAllowedTools: { type: "array", items: { type: "string" }, default: [] },
    acpBackendId: { type: "string", default: "claude-code" },
  },
  required: [],
} as const;

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "claude-code-openclaw-plugin",
  name: "Claude Code harness",
  description: "Add Claude Code harness tools to OpenClaw.",
  configSchema: buildJsonPluginConfigSchema(pluginConfigJsonSchema),
  register(api: OpenClawPluginApi) {
    const rawConfig = api.pluginConfig ?? {};
    const config = resolvePluginConfig(rawConfig);
    const eventLogger = createSessionEventLogger({
      dir: config.stateFileDir,
      enabled: config.debugLog,
    });
    const store = createSessionStore({
      stateFileDir: config.stateFileDir,
      eventLogger,
    });

    const { eventStreamer } = registerClaudeCodeAcpBackend({
      config,
      store,
      log: (text) => api.logger?.info?.(text),
    });

    const routes = createClaudeCodeRoutes({
      store,
      config,
      log: (text) => api.logger?.info?.(text),
      discoverSession: async (sessionId) => discoverSession({ sessionId }),
      onHookTransition: (state) => {
        eventStreamer.notifyState(state.sessionId, state.state);
      },
    });

    api.registerHttpRoute({
      path: `${config.routePrefix}/hook`,
      auth: "plugin",
      match: "exact",
      handler: routes.hook,
    });

    api.registerHttpRoute({
      path: `${config.routePrefix}/setup-hooks`,
      auth: "plugin",
      match: "exact",
      handler: routes.setupHooks,
    });

    // Only the setup-hooks tool remains; ACP replaces spawn/stop/restore/send/read/status.
    api.registerTool(() => createClaudeCodeSetupHooksTool());

    let timeoutTimer: NodeJS.Timeout | undefined;
    api.registerService({
      id: "claude-code-session-timeout",
      start: async () => {
        await store.loadFromDisk();
        const intervalMs = Math.min(config.sessionTimeoutSeconds * 1000, 60_000);
        timeoutTimer = setInterval(() => {
          const now = Date.now();
          const timeoutMs = config.sessionTimeoutSeconds * 1000;
          for (const state of store.listStates()) {
            if (state.state === "DONE" || state.state === "FATAL") continue;
            if (now - state.lastSeenAt > timeoutMs) {
              const updated = store.markFatal(
                state.sessionId,
                "no hook received within sessionTimeoutSeconds",
              );
              if (updated) {
                eventStreamer.notifyState(updated.sessionId, updated.state);
              }
            }
          }
        }, intervalMs);
        timeoutTimer.unref();
      },
      stop: () => {
        if (timeoutTimer) clearInterval(timeoutTimer);
        void store.dispose();
      },
    });
  },
});

export default plugin;
