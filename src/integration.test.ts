import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import entry from "./index.js";

function mockReq(body: unknown): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = "POST";
  req.url = "/claude-code/hook";
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
  res.writeHead = ((_code: number) => res) as ServerResponse["writeHead"];
  res.end = ((body?: string) => {
    (res as unknown as { body: string }).body = body ?? "";
    return res;
  }) as ServerResponse["end"];
  return res;
}

describe("hook event enqueues system event", () => {
  it("WAITING hook triggers enqueueSystemEvent", async () => {
    const systemEvents: Array<{ text: string; opts: Record<string, unknown> }> = [];
    const routes: Array<{
      path: string;
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    }> = [];

    const api = {
      pluginConfig: {
        targetSessionKey: "agent:main:main",
        notifyStates: ["WAITING"],
        stateFileDir: "~/.cache/claude-code-integration-test",
      },
      runtime: {
        system: {
          enqueueSystemEvent: (text: string, opts: Record<string, unknown>) => {
            systemEvents.push({ text, opts });
            return true;
          },
          requestHeartbeat: () => {},
        },
      },
      registerHttpRoute: (params: {
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
      }) => {
        routes.push(params);
      },
      registerTool: () => {},
      registerHook: () => {},
      registerService: () => {},
    };

    entry.register!(api as never);
    const hookRoute = routes.find((r) => r.path === "/claude-code/hook");
    expect(hookRoute).toBeDefined();

    const req = mockReq({
      hook_event_name: "Stop",
      session_id: "integration-s1",
    });
    const res = mockRes();
    await hookRoute!.handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(systemEvents).toHaveLength(1);
    expect(systemEvents[0].text).toContain("waiting for input");
    expect(systemEvents[0].opts).toMatchObject({
      sessionKey: "agent:main:main",
      contextKey: "cron:claude-code:integration-s1",
    });
  });
});
