import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionStore } from "./store.js";
import { createClaudeCodeRoutes } from "./routes.js";

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
  const store = createSessionStore({ stateFileDir: "/tmp/routes-test" });
  const routes = createClaudeCodeRoutes({
    store,
    config: {
      routePrefix: "/claude-code",
      eventTypes: ["*"],
      notifyStates: ["WAITING"],
      sendKeysRateLimitPerMinute: 10,
      sessionTimeoutSeconds: 300,
      stateFileDir: "/tmp/routes-test",
    },
    requestHeartbeatNow: vi.fn(),
  });

  afterEach(async () => {
    await store.dispose();
  });

  it("accepts a hook and returns 200", async () => {
    const req = mockReq({
      method: "POST",
      path: "/claude-code/hook",
      body: { hook_event_name: "Stop", session_id: "s1" },
    });
    const res = mockRes();
    await routes.hook(req, res);
    expect(res.statusCode).toBe(200);
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
});
