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
import { createClaudeCodeRoutes } from "./routes.js";
import { createSessionStore } from "./store.js";
import { sendKeysToTmuxSession, tmuxSessionExists } from "./tmux.js";
import { createClaudeCodeStatusTool } from "./tools.js";

import { createClaudeCodeSpawnTool } from "./spawn.js";
import { createClaudeCodeStopTool } from "./stop.js";
import { createClaudeCodeRestoreTool } from "./restore.js";
import { createClaudeCodeSetupHooksTool } from "./setup-hooks.js";
import { createBehaviorDispatcher } from "./dispatcher.js";
import { buildClaudeCodeContext } from "./context.js";

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
    const store = createSessionStore({ stateFileDir: config.stateFileDir });

    const dispatcher = createBehaviorDispatcher({
      enqueueSystemEvent: (text, opts) => {
        try {
          return api.runtime.system.enqueueSystemEvent(text, opts);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("claude-code: enqueueSystemEvent failed:", err);
          return false;
        }
      },
      requestHeartbeat: (opts) => {
        try {
          api.runtime.system.requestHeartbeat(opts);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("claude-code: requestHeartbeat failed:", err);
        }
      },
      notifyStates: config.notifyStates,
      sessionKey: config.targetSessionKey,
    });

    const routes = createClaudeCodeRoutes({
      store,
      config,
      dispatcher,
      discoverSession: async (sessionId) => discoverSession({ sessionId }),
      sendKeys: async ({ tmuxSession, text, submit }) => {
        const exists = await tmuxSessionExists(tmuxSession);
        if (!exists) throw new Error(`tmux session ${tmuxSession} not found`);
        await sendKeysToTmuxSession({ tmuxSession, text, submit });
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

    api.registerHook(
      "heartbeat_prompt_contribution",
      (async () => {
        const ctx = buildClaudeCodeContext({
          sessions: store.listStates(),
          notifyStates: config.notifyStates,
        });
        return { appendContext: ctx ?? "" };
      }) as unknown as Parameters<OpenClawPluginApi["registerHook"]>[1],
      {
        name: "claude-code-heartbeat-context",
        description: "Inject active Claude Code sessions into heartbeat prompts",
      },
    );

    api.registerTool(createClaudeCodeStatusTool(store));
    api.registerTool(createClaudeCodeSpawnTool());
    api.registerTool(createClaudeCodeStopTool());
    api.registerTool(createClaudeCodeRestoreTool());
    api.registerTool(createClaudeCodeSetupHooksTool());

    let timeoutTimer: NodeJS.Timeout | undefined;
    api.registerService({
      id: "claude-code-session-timeout",
      start: async () => {
        await store.loadFromDisk();
        const intervalMs = Math.min(config.sessionTimeoutSeconds * 1000, 60_000);
        timeoutTimer = setInterval(() => {
          const now = Date.now();
          for (const state of store.listStates()) {
            if (now - state.lastSeenAt > config.sessionTimeoutSeconds * 1000) {
              const updated = store.markFatal(
                state.sessionId,
                "no hook received within sessionTimeoutSeconds",
              );
              if (updated) {
                dispatcher.onStateChanged(updated);
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
