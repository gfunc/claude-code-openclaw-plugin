import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionStore } from "./store.js";
import { createClaudeCodeRoutes } from "./routes.js";
import type { PluginConfig } from "./config.js";
import type { SessionState } from "./state.js";
import type { TaskRegistry } from "./task-registry.js";

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

describe("createClaudeCodeRoutes", () => {
  let store: ReturnType<typeof createSessionStore>;
  let routes: ReturnType<typeof createClaudeCodeRoutes>;
  let taskRegistry: TaskRegistry;
  let sendKeys: ReturnType<typeof vi.fn>;
  const config: PluginConfig = {
    routePrefix: "/claude-code",
    eventTypes: ["*"],
    notifyStates: ["WAITING"],
    sendKeysRateLimitPerMinute: 10,
    sessionTimeoutSeconds: 300,
    targetSessionKey: "agent:main:main",
    permissionMode: "bypassPermissions",
    stateFileDir: "/tmp/routes-test",
    debugLog: false,
  };

  beforeEach(() => {
    store = createSessionStore({ stateFileDir: "/tmp/routes-test" });
    taskRegistry = {
      createTask: vi.fn(),
      onStateTransition: vi.fn(),
    } as unknown as TaskRegistry;
    sendKeys = vi.fn();
    routes = createClaudeCodeRoutes({
      store,
      config,
      taskRegistry,
      sendKeys,
    });
  });

  afterEach(async () => {
    await store.dispose();
  });

  it("accepts a hook and returns 200 with ok: true", async () => {
    const req = mockReq({
      method: "POST",
      path: "/claude-code/hook",
      body: { hook_event_name: "Stop", session_id: "s1" },
    });
    const res = mockRes();
    await routes.hook(req, res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse((res as unknown as { body: string }).body);
    expect(body).toEqual({ ok: true });
  });

  it("delegates state change to taskRegistry", async () => {
    const req = mockReq({
      method: "POST",
      path: "/claude-code/hook",
      body: { hook_event_name: "Stop", session_id: "s2" },
    });
    const res = mockRes();
    await routes.hook(req, res);
    expect(taskRegistry.onStateTransition).toHaveBeenCalled();
    const callArgs = (taskRegistry.onStateTransition as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const stateArg = callArgs?.[0] as SessionState;
    expect(stateArg.state).toBe("WAITING");
  });

  it("returns 404 for unknown tmux session on send", async () => {
    const req = mockReq({
      method: "POST",
      path: "/claude-code/unknown/send",
      body: { text: "hi", submit: true },
    });
    const res = mockRes();
    await routes.send(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("successfully sends keys and returns sent: true with sessionId", async () => {
    await store.applyHook(
      { hook_event_name: "Stop", session_id: "sess-1" },
      async () => ({
        tmuxSession: "tmux-1",
        sessionId: "sess-1",
        logFile: "/tmp/routes-test/tmux-1.log",
      }),
    );

    const req = mockReq({
      method: "POST",
      path: "/claude-code/tmux-1/send",
      body: { text: "hello", submit: true },
    });
    const res = mockRes();
    await routes.send(req, res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse((res as unknown as { body: string }).body);
    expect(body).toEqual({ sent: true, sessionId: "sess-1" });
    expect(sendKeys).toHaveBeenCalledWith({
      tmuxSession: "tmux-1",
      text: "hello",
      submit: true,
    });
  });

  it("returns 400 for non-object body in send", async () => {
    await store.applyHook(
      { hook_event_name: "Stop", session_id: "sess-2" },
      async () => ({
        tmuxSession: "tmux-2",
        sessionId: "sess-2",
        logFile: "/tmp/routes-test/tmux-2.log",
      }),
    );

    const req = mockReq({
      method: "POST",
      path: "/claude-code/tmux-2/send",
      body: "not-an-object",
    });
    const res = mockRes();
    await routes.send(req, res);
    expect(res.statusCode).toBe(400);
    const body = JSON.parse((res as unknown as { body: string }).body);
    expect(body).toEqual({ error: "invalid body" });
  });
});
