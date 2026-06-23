import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import entry from "./index.js";

type HookEntry = {
  events: string | string[];
  name: string;
  description?: string;
  handler: (event: unknown) => Promise<unknown> | unknown;
};

function mockReq({
  method,
  path,
  body,
}: {
  method: string;
  path: string;
  body: unknown;
}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = { "content-type": "application/json" };
  setImmediate(() => {
    req.emit("data", Buffer.from(JSON.stringify(body), "utf8"));
    req.emit("end");
  });
  return req;
}

function mockRes(): ServerResponse {
  const res = new EventEmitter() as unknown as ServerResponse;
  res.statusCode = 200;
  res.writeHead = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as ServerResponse["writeHead"];
  res.end = vi.fn((body?: string) => {
    (res as unknown as { body: string }).body = body ?? "";
    return res;
  }) as unknown as ServerResponse["end"];
  return res;
}

function createMockApi(pluginConfig?: Record<string, unknown>) {
  const hooks: HookEntry[] = [];
  const httpRoutes: Array<{ path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }> = [];
  const tools: Array<{ name: string }> = [];
  const services: Array<{ id: string; start: () => Promise<void> }> = [];
  const systemEvents: Array<{ text: string; opts: Record<string, unknown> }> = [];
  const heartbeatRequests: Array<Record<string, unknown>> = [];

  const api = {
    pluginConfig,
    runtime: {
      system: {
        enqueueSystemEvent: (text: string, opts: Record<string, unknown>) => {
          systemEvents.push({ text, opts });
          return true;
        },
        requestHeartbeat: (opts: Record<string, unknown>) => {
          heartbeatRequests.push(opts);
        },
      },
    },
    registerHttpRoute: (params: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => {
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

  return { api, hooks, httpRoutes, tools, services, systemEvents, heartbeatRequests };
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

  it("heartbeat_prompt_contribution handler returns appendContext", async () => {
    const { api, hooks } = createMockApi();
    entry.register!(api as never);
    const contribution = hooks.find((h) =>
      Array.isArray(h.events)
        ? h.events.includes("heartbeat_prompt_contribution")
        : h.events === "heartbeat_prompt_contribution",
    );
    expect(contribution).toBeDefined();
    const result = await contribution!.handler({ sessionKey: "test-session" });
    expect(result).toEqual({ appendContext: "" });
  });

  it("requests heartbeat through runtime system when target session differs from main", async () => {
    const { api, httpRoutes, heartbeatRequests } = createMockApi({
      targetSessionKey: "agent:cc-watcher:main",
    });
    entry.register!(api as never);
    const hookRoute = httpRoutes.find((r) => r.path === "/claude-code/hook");
    expect(hookRoute).toBeDefined();

    const req = mockReq({
      method: "POST",
      path: "/claude-code/hook",
      body: { hook_event_name: "Stop", session_id: "test-session" },
    });
    const res = mockRes();
    await hookRoute!.handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse((res as unknown as { body: string }).body)).toEqual({ ok: true });
    expect(heartbeatRequests).toHaveLength(1);
    expect(heartbeatRequests[0]).toEqual({
      source: "cron",
      intent: "immediate",
      reason: "claude-code-state-change",
      sessionKey: "agent:cc-watcher:main",
      agentId: "cc-watcher",
      heartbeat: { target: "last" },
    });
  });
});
