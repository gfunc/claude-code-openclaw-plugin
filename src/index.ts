import { buildPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { buildClaudeCodeContext } from "./context.js";
import { pluginConfigSchema, resolvePluginConfig } from "./config.js";
import { discoverSession } from "./discovery.js";
import { createClaudeCodeRoutes } from "./routes.js";
import { createSessionStore } from "./store.js";
import { sendKeysToTmuxSession, tmuxSessionExists } from "./tmux.js";
import { createClaudeCodeStatusTool } from "./tools.js";

export default definePluginEntry({
  id: "claude-code-openclaw-plugin",
  name: "Claude Code harness",
  description: "Add Claude Code harness tools to OpenClaw.",
  configSchema: buildPluginConfigSchema(pluginConfigSchema),
  register(api: OpenClawPluginApi) {
    const rawConfig = api.pluginConfig ?? {};
    const config = resolvePluginConfig(rawConfig);
    const store = createSessionStore({ stateFileDir: config.stateFileDir });
    const requestHeartbeatNow = () => {
      try {
        api.runtime.system.requestHeartbeatNow();
      } catch {
        // ignore
      }
    };

    const routes = createClaudeCodeRoutes({
      store,
      config,
      requestHeartbeatNow,
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
      path: `${config.routePrefix}/`,
      auth: "plugin",
      match: "prefix",
      handler: routes.send,
    });

    api.registerHook("before_prompt_build", async () => {
      const context = buildClaudeCodeContext({
        sessions: store.listStates(),
        notifyStates: config.notifyStates,
      });
      return context ? { prependContext: context } : undefined;
    });

    api.registerTool(createClaudeCodeStatusTool(store));

    let timeoutTimer: ReturnType<typeof setInterval> | undefined;
    api.registerService({
      id: "claude-code-session-timeout",
      start: () => {
        const intervalMs = Math.min(config.sessionTimeoutSeconds * 1000, 60_000);
        timeoutTimer = setInterval(() => {
          const now = Date.now();
          for (const state of store.listStates()) {
            if (now - state.lastSeenAt > config.sessionTimeoutSeconds * 1000) {
              const updated = store.markFatal(state.sessionId, "no hook received within sessionTimeoutSeconds");
              if (updated && config.notifyStates.includes("FATAL")) {
                requestHeartbeatNow();
              }
            }
          }
        }, intervalMs);
        timeoutTimer.unref?.();
      },
      stop: () => {
        if (timeoutTimer) clearInterval(timeoutTimer);
        void store.dispose();
      },
    });
  },
});
