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
import { sendKeysSequence, sendKeysToTmuxSession, tmuxSessionExists } from "./tmux.js";
import { createClaudeCodeStatusTool } from "./tools.js";

import { createClaudeCodeSpawnTool } from "./spawn.js";
import { createClaudeCodeStopTool } from "./stop.js";
import { createClaudeCodeRestoreTool } from "./restore.js";
import { createClaudeCodeSendTool } from "./send.js";
import { createClaudeCodeReadTool } from "./read.js";
import { createClaudeCodeSetupHooksTool } from "./setup-hooks.js";
import { createTaskRegistry } from "./task-registry.js";

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
    notifyStates: {
      type: "array",
      items: { type: "string" },
      default: ["WAITING", "QUESTION", "PERMISSION", "ERROR", "DONE"],
    },
    sendKeysRateLimitPerMinute: { type: "number", default: 10 },
    sessionTimeoutSeconds: { type: "number", default: 300 },
    targetSessionKey: { type: "string", default: "agent:main:main" },
    permissionMode: {
      type: "string",
      enum: ["default", "acceptEdits", "plan", "bypassPermissions"],
      default: "bypassPermissions",
    },
    debugLog: { type: "boolean", default: false },
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

    const taskReg = createTaskRegistry({
      requesterSessionKey: config.targetSessionKey,
    });

    const routes = createClaudeCodeRoutes({
      store,
      config,
      taskRegistry: taskReg,
      discoverSession: async (sessionId) => discoverSession({ sessionId }),
      sendKeys: async ({ tmuxSession, text, submit, keys }) => {
        const exists = await tmuxSessionExists(tmuxSession);
        if (!exists) throw new Error(`tmux session ${tmuxSession} not found`);
        if (text) await sendKeysToTmuxSession({ tmuxSession, text, submit });
        if (keys && keys.length) await sendKeysSequence({ tmuxSession, keys });
      },
    });

    api.registerHttpRoute({
      path: `${config.routePrefix}/hook`,
      auth: "plugin",
      match: "exact",
      handler: routes.hook,
    });

    api.registerHttpRoute({
      path: `${config.routePrefix}/spawn`,
      auth: "plugin",
      match: "exact",
      handler: routes.spawn,
    });

    api.registerHttpRoute({
      path: `${config.routePrefix}/setup-hooks`,
      auth: "plugin",
      match: "exact",
      handler: routes.setupHooks,
    });

    api.registerHttpRoute({
      path: `${config.routePrefix}/`,
      auth: "plugin",
      match: "prefix",
      handler: routes.dispatch,
    });

    api.registerTool(createClaudeCodeStatusTool(store));
    api.registerTool(createClaudeCodeSpawnTool({
      permissionMode: config.permissionMode,
      taskRegistry: taskReg,
      requesterSessionKey: config.targetSessionKey,
    }));
    api.registerTool(createClaudeCodeStopTool());
    api.registerTool(createClaudeCodeRestoreTool({ permissionMode: config.permissionMode }));
    api.registerTool(createClaudeCodeSendTool());
    api.registerTool(createClaudeCodeReadTool());
    api.registerTool(createClaudeCodeSetupHooksTool());

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
                taskReg.onStateTransition(updated, "WORKING");
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
