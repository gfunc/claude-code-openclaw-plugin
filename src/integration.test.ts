import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "openclaw/plugin-sdk/system-event-runtime";
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

function buildApi(opts: {
  stateDir: string;
  targetSessionKey?: string;
  notifyStates?: string[];
  heartbeats?: Array<Record<string, unknown>>;
}): {
  api: Record<string, unknown>;
  routes: Array<{
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  }>;
  heartbeats: Array<Record<string, unknown>>;
} {
  const routes: Array<{
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  }> = [];
  const heartbeats = opts.heartbeats ?? [];

  const api = {
    pluginConfig: {
      targetSessionKey: opts.targetSessionKey ?? "agent:main:main",
      notifyStates: opts.notifyStates ?? ["WAITING", "QUESTION", "PERMISSION", "ERROR", "DONE"],
      stateFileDir: opts.stateDir,
    },
    runtime: {
      system: {
        // Real system-event queue — same global Map the gateway kernel uses.
        enqueueSystemEvent,
        requestHeartbeatNow: (hbOpts: Record<string, unknown>) => {
          heartbeats.push(hbOpts);
        },
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
      // Auto-start registered services so the timeout service doesn't block.
      svc.start().catch(() => {});
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };

  return { api, routes, heartbeats };
}

describe("hook → system-event queue (full integration)", () => {
  let stateDir: string;

  afterEach(async () => {
    resetSystemEventsForTest();
    if (stateDir) await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  it("Stop hook enqueues a task:claude-code:* event into the real queue", async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-plugin-e2e-"));
    const { api, routes } = buildApi({ stateDir });

    entry.register!(api as never);
    const hookRoute = routes.find((r) => r.path === "/claude-code/hook");
    expect(hookRoute).toBeDefined();

    const req = mockReq({ hook_event_name: "Stop", session_id: "e2e-real-1" });
    const res = mockRes();
    await hookRoute!.handler(req, res);

    expect(res.statusCode).toBe(200);

    const entries = peekSystemEventEntries("agent:main:main");
    expect(entries).toHaveLength(1);
    expect(entries[0].contextKey).toBe("task:claude-code:e2e-real-1");
    expect(entries[0].text).toContain("needs attention");
  });

  it("DONE hook enqueues a terminal event with result text", async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-plugin-e2e-"));
    const { api, routes } = buildApi({ stateDir });

    entry.register!(api as never);
    const hookRoute = routes.find((r) => r.path === "/claude-code/hook");
    expect(hookRoute).toBeDefined();

    const req = mockReq({
      hook_event_name: "SessionEnd",
      session_id: "e2e-real-2",
      last_assistant_message: "parity report done — 7 gaps found",
    });
    await hookRoute!.handler(req, mockRes());

    const entries = peekSystemEventEntries("agent:main:main");
    expect(entries).toHaveLength(1);
    expect(entries[0].contextKey).toBe("task:claude-code:e2e-real-2");
    expect(entries[0].text).toContain("finished");
    expect(entries[0].text).toContain("parity report done");
  });

  it("wake fires via requestHeartbeatNow on terminal state (DONE)", async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-plugin-e2e-"));
    const { api, routes, heartbeats } = buildApi({ stateDir });

    entry.register!(api as never);
    const hookRoute = routes.find((r) => r.path === "/claude-code/hook");
    expect(hookRoute).toBeDefined();

    await hookRoute!.handler(
      mockReq({
        hook_event_name: "SessionEnd",
        session_id: "e2e-real-3",
        last_assistant_message: "done",
      }),
      mockRes(),
    );

    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]).toMatchObject({
      source: "hook",
      intent: "immediate",
      sessionKey: "agent:main:main",
      reason: "claude-code:e2e-real-3:DONE",
    });
  });

  it("WORKING hooks do not enqueue notify events", async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-plugin-e2e-"));
    const { api, routes } = buildApi({ stateDir });

    entry.register!(api as never);
    const hookRoute = routes.find((r) => r.path === "/claude-code/hook");
    expect(hookRoute).toBeDefined();

    await hookRoute!.handler(
      mockReq({ hook_event_name: "UserPromptSubmit", session_id: "e2e-real-4" }),
      mockRes(),
    );
    await hookRoute!.handler(
      mockReq({ hook_event_name: "PreToolUse", session_id: "e2e-real-4", tool_name: "Bash" }),
      mockRes(),
    );

    const entries = peekSystemEventEntries("agent:main:main");
    expect(entries).toHaveLength(0);
  });

  it("full session lifecycle: WORKING → WAITING → DONE", async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-plugin-e2e-"));
    const heartbeats: Array<Record<string, unknown>> = [];
    const { api, routes } = buildApi({ stateDir, heartbeats });

    entry.register!(api as never);
    const hookRoute = routes.find((r) => r.path === "/claude-code/hook");
    expect(hookRoute).toBeDefined();
    const post = (body: Record<string, unknown>) => hookRoute!.handler(mockReq(body), mockRes());

    const sid = "e2e-lifecycle";

    // WORKING hooks → no events
    await post({ hook_event_name: "UserPromptSubmit", session_id: sid });
    await post({ hook_event_name: "PreToolUse", session_id: sid, tool_name: "Bash" });
    await post({ hook_event_name: "PostToolUse", session_id: sid, tool_name: "Bash" });
    expect(peekSystemEventEntries("agent:main:main")).toHaveLength(0);

    // Stop → WAITING → one notify event, no wake
    await post({ hook_event_name: "Stop", session_id: sid });
    let entries = peekSystemEventEntries("agent:main:main");
    expect(entries).toHaveLength(1);
    expect(entries[0].contextKey).toBe(`task:claude-code:${sid}`);
    expect(entries[0].text).toContain("needs attention");
    expect(heartbeats).toHaveLength(0); // intermediate states don't wake

    // SessionEnd → DONE → terminal event + wake
    await post({
      hook_event_name: "SessionEnd",
      session_id: sid,
      last_assistant_message: "all done",
    });
    entries = peekSystemEventEntries("agent:main:main");
    const doneEntry = entries.find(
      (e) => e.contextKey === `task:claude-code:${sid}` && e.text.includes("finished"),
    );
    expect(doneEntry).toBeDefined();
    if (doneEntry) expect(doneEntry.text).toContain("all done");
    expect(heartbeats).toHaveLength(1); // only the DONE wake
  });
});
