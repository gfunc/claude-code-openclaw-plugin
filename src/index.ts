import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
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
    wecomWebhookUrl: { type: "string" },
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
      enqueueSystemEvent: (text, opts) => {
        try {
          const ok = api.runtime.system.enqueueSystemEvent(text, opts);
          if (!ok) {
            api.logger?.warn(
              `claude-code: enqueueSystemEvent returned false contextKey=${opts.contextKey} sessionKey=${opts.sessionKey}`,
            );
          }
          return ok;
        } catch (err) {
          api.logger?.warn(`claude-code: enqueueSystemEvent threw: ${String(err)}`);
          return false;
        }
      },
      requestHeartbeatNow: (opts) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          api.runtime.system.requestHeartbeatNow(opts as any);
        } catch (err) {
          api.logger?.warn(`claude-code: requestHeartbeatNow failed: ${String(err)}`);
        }
      },
      log: (text) => api.logger?.info?.(text),
      requesterSessionKey: config.targetSessionKey,
      onTerminalState: ({ sessionId, label, state, text }) => {
            const resultText = text.replace("🚨 Claude Code session", "Claude Code session");
            // Primary: session resume — inject follow-up into the requester session
            // so the agent can review results, make decisions, and reply to the user.
            // Mirrors the exec-approval-followup pattern (bash-tools exec-approval-followup.ts).
            dispatchGatewayMethod("agent", {
              sessionKey: config.targetSessionKey,
              message: [
                "A background Claude Code session has completed.",
                "Do not re-run the analysis.",
                "If the task requires more steps, continue from this result before replying to the user.",
                "Only ask the user for help if you are actually blocked.",
                "",
                "Exact completion details:",
                resultText.slice(0, 4000),
                "",
                "Continue the task if needed, then reply to the user in a helpful way.",
                "Share the key findings, recommendations, and any decisions needed.",
              ].join("\n"),
            }).catch((err) => {
              api.logger?.warn(`claude-code: session resume failed: ${String(err)}`);
            });

            // Fallback: wecom webhook for push notification when session resume
            // isn't available (matching sendDirectFollowupFallback pattern).
            if (config.wecomWebhookUrl) {
              const markdown = `## ${state === "FATAL" ? "⏰ Timed Out" : "✅ Completed"}: \`${label}\`\n> ${text.replace(/🚨 Claude Code session.*?\*\*/, "").slice(0, 2000)}`;
              fetch(config.wecomWebhookUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  msgtype: "markdown",
                  markdown: { content: markdown },
                }),
              }).catch((err) => {
                api.logger?.warn(`claude-code: wecom webhook failed: ${String(err)}`);
              });
            }
          },
    });

    const routes = createClaudeCodeRoutes({
      store,
      config,
      taskRegistry: taskReg,
      log: (text) => api.logger?.info?.(text),
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
                taskReg.onStateTransition(updated);
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
