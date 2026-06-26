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

describe("hook event flow", () => {
  it("Stop hook returns 200 OK and doesn't crash without a host runtime", async () => {
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
          enqueueSystemEvent: () => true,
          requestHeartbeatNow: () => {},
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
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
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
  });
});
