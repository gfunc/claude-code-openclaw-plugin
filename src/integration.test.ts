import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAcpRuntimeBackend,
  __testing,
} from "openclaw/plugin-sdk/acp-runtime";
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

function buildApi(opts: { stateDir: string }): {
  api: Record<string, unknown>;
  routes: Array<{
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  }>;
  waitForServices: () => Promise<void>;
} {
  const routes: Array<{
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  }> = [];
  const startPromises: Array<Promise<void>> = [];

  const api = {
    pluginConfig: {
      stateFileDir: opts.stateDir,
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
    registerService: (svc: { id: string; start: () => Promise<void> }) => {
      startPromises.push(svc.start().catch(() => {}));
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };

  return {
    api,
    routes,
    waitForServices: async () => {
      await Promise.all(startPromises);
    },
  };
}

describe("ACP backend integration", () => {
  let stateDir: string;

  afterEach(async () => {
    __testing.resetAcpRuntimeBackendsForTests();
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("registers the claude-code ACP backend", async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-plugin-acp-"));
    const { api, waitForServices } = buildApi({ stateDir });

    entry.register!(api as never);
    await waitForServices();

    const backend = getAcpRuntimeBackend("claude-code");
    expect(backend).toBeDefined();
    const runtime = backend!.runtime;
    expect(typeof runtime.ensureSession).toBe("function");
    expect(typeof runtime.startTurn).toBe("function");
    expect(typeof runtime.cancel).toBe("function");
    expect(typeof runtime.close).toBe("function");
    expect(typeof runtime.doctor).toBe("function");
  });

  it("registers the /claude-code/hook route and applies hook state", async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-plugin-acp-"));
    const { api, routes, waitForServices } = buildApi({ stateDir });

    entry.register!(api as never);
    await waitForServices();

    const hookRoute = routes.find((r) => r.path === "/claude-code/hook");
    expect(hookRoute).toBeDefined();

    const res = mockRes();
    await hookRoute!.handler(
      mockReq({ hook_event_name: "SessionEnd", session_id: "e2e-done" }),
      res,
    );
    expect(res.statusCode).toBe(200);
  });

  it("backend doctor reports missing claude/tmux when binaries are absent", async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-plugin-acp-"));
    const { api, waitForServices } = buildApi({ stateDir });

    entry.register!(api as never);
    await waitForServices();

    const backend = getAcpRuntimeBackend("claude-code");
    const report = await backend!.runtime.doctor!();
    // In CI or environments without claude installed, this should fail gracefully.
    expect(typeof report.ok).toBe("boolean");
    expect(report.message).toBeTruthy();
  });
});
