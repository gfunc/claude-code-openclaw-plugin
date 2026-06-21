import { describe, expect, it } from "vitest";
import entry from "./index.js";

type HookEntry = {
  events: string | string[];
  name: string;
  description?: string;
  handler: (event: unknown) => Promise<unknown> | unknown;
};

function createMockApi(pluginConfig?: Record<string, unknown>) {
  const hooks: HookEntry[] = [];
  const httpRoutes: Array<{ path: string; handler: unknown }> = [];
  const tools: Array<{ name: string }> = [];
  const services: Array<{ id: string; start: () => Promise<void> }> = [];
  const heartbeats: Array<Record<string, unknown>> = [];
  const systemEvents: Array<{ text: string; opts: Record<string, unknown> }> = [];

  const api = {
    pluginConfig,
    runtime: {
      system: {
        requestHeartbeat: (opts: Record<string, unknown>) => {
          heartbeats.push(opts);
        },
        requestHeartbeatNow: () => {
          heartbeats.push({ now: true });
        },
        enqueueSystemEvent: (text: string, opts: Record<string, unknown>) => {
          systemEvents.push({ text, opts });
        },
      },
    },
    registerHttpRoute: (params: { path: string; handler: unknown }) => {
      httpRoutes.push(params);
    },
    registerTool: (tool: { name: string }) => {
      tools.push(tool);
    },
    registerHook: (
      events: string | string[],
      handler: (event: unknown) => Promise<unknown> | unknown,
      opts?: { name?: string; description?: string },
    ) => {
      hooks.push({
        events,
        name: opts?.name ?? "unnamed",
        description: opts?.description,
        handler,
      });
    },
    registerService: (service: { id: string; start: () => Promise<void> }) => {
      services.push(service);
    },
  };

  return { api, hooks, httpRoutes, tools, services, heartbeats, systemEvents };
}

describe("claude-code-openclaw-plugin", () => {
  it("exports a defined plugin entry", () => {
    expect(entry.id).toBe("claude-code-openclaw-plugin");
    expect(entry.register).toBeTypeOf("function");
  });

  it("registers heartbeat_prompt_contribution hook", () => {
    const { api, hooks } = createMockApi();
    entry.register!(api as never);
    const contribution = hooks.find((h) =>
      Array.isArray(h.events)
        ? h.events.includes("heartbeat_prompt_contribution")
        : h.events === "heartbeat_prompt_contribution",
    );
    expect(contribution).toBeDefined();
    expect(contribution?.name).toBe("claude-code-heartbeat-context");
  });

  it("heartbeat_prompt_contribution handler does not throw", async () => {
    const { api, hooks } = createMockApi();
    entry.register!(api as never);
    const contribution = hooks.find((h) =>
      Array.isArray(h.events)
        ? h.events.includes("heartbeat_prompt_contribution")
        : h.events === "heartbeat_prompt_contribution",
    );
    expect(contribution).toBeDefined();
    const handler = contribution!.handler;
    await expect(handler({ sessionKey: "test-session" })).resolves.not.toThrow();
  });
});
