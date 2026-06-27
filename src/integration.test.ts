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
  defaultNotifySessionKey?: string;
  heartbeats?: Array<Record<string, unknown>>;
}): {
  api: Record<string, unknown>;
  routes: Array<{
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  }>;
  heartbeats: Array<Record<string, unknown>>;
  waitForServices: () => Promise<void>;
} {
  const routes: Array<{
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  }> = [];
  const heartbeats = opts.heartbeats ?? [];
  const startPromises: Array<Promise<void>> = [];

  const api = {
    pluginConfig: {
      defaultNotifySessionKey: opts.defaultNotifySessionKey ?? "agent:main:main",
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
      // Auto-start registered services so the timeout service doesn't block,
      // and track the start promise so tests can await disk hydration.
      startPromises.push(svc.start().catch(() => {}));
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };

  return {
    api,
    routes,
    heartbeats,
    waitForServices: async () => {
      await Promise.all(startPromises);
    },
  };
}

describe("hook → system-event queue (full integration)", () => {
  let stateDir: string;

  afterEach(async () => {
    resetSystemEventsForTest();
    if (stateDir) await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  it("Stop hook enqueues a cron:claude-code:* event into the real queue", async () => {
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
    expect(entries[0].contextKey).toBe("cron:claude-code:e2e-real-1");
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
    expect(entries[0].contextKey).toBe("cron:claude-code:e2e-real-2");
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

    // Stop → WAITING → one notify event AND wake (per-caller design: all
    // notify states wake, including intermediates).
    await post({ hook_event_name: "Stop", session_id: sid });
    let entries = peekSystemEventEntries("agent:main:main");
    expect(entries).toHaveLength(1);
    expect(entries[0].contextKey).toBe(`cron:claude-code:${sid}`);
    expect(entries[0].text).toContain("needs attention");
    expect(heartbeats).toHaveLength(1); // intermediate states wake too
    expect(heartbeats[0]).toMatchObject({
      source: "hook",
      intent: "immediate",
      sessionKey: "agent:main:main",
      reason: `claude-code:${sid}:WAITING`,
    });

    // SessionEnd → DONE → terminal event + wake
    await post({
      hook_event_name: "SessionEnd",
      session_id: sid,
      last_assistant_message: "all done",
    });
    entries = peekSystemEventEntries("agent:main:main");
    const doneEntry = entries.find(
      (e) => e.contextKey === `cron:claude-code:${sid}` && e.text.includes("finished"),
    );
    expect(doneEntry).toBeDefined();
    if (doneEntry) expect(doneEntry.text).toContain("all done");
    expect(heartbeats).toHaveLength(2); // WAITING wake + DONE wake
    expect(heartbeats[1]).toMatchObject({
      source: "hook",
      intent: "immediate",
      sessionKey: "agent:main:main",
      reason: `claude-code:${sid}:DONE`,
    });
  });

  it("routes all notifications to defaultNotifySessionKey hub", async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-plugin-e2e-"));
    // Pre-seed a SessionState file as if spawn had stored caller routing.
    // This bypasses the real spawn (which would launch tmux) and exercises
    // the integration target: hooks for a session whose store entry has
    // notifySessionKey + notifyDeliveryContext. All notifications route to
    // defaultNotifySessionKey (hub); loadFromDisk picks this up at service start.
    const sid = "e2e-wecom";
    const now = Date.now();
    await fs.writeFile(
      path.join(stateDir, `${sid}.json`),
      JSON.stringify({
        sessionId: sid,
        state: "WORKING",
        lastHookEvent: "SessionStart",
        lastHookPayload: { hook_event_name: "SessionStart", session_id: sid },
        stateSince: now,
        lastSeenAt: now,
        history: [],
        runId: sid,
        notifySessionKey: "agent:wecom:user-99",
        notifyDeliveryContext: { channel: "wecom", to: "user-99", accountId: "ww-7" },
      }),
      "utf8",
    );

    const heartbeats: Array<Record<string, unknown>> = [];
    const { api, routes, waitForServices } = buildApi({ stateDir, heartbeats });

    entry.register!(api as never);
    // Wait for the timeout service to finish loadFromDisk hydration.
    await waitForServices();

    const hookRoute = routes.find((r) => r.path === "/claude-code/hook");
    expect(hookRoute).toBeDefined();

    // Verify hydration: the store should have loaded notifySessionKey from disk.
    // (peek default before firing — should be empty, with routing now applied.)
    expect(peekSystemEventEntries("agent:main:main")).toHaveLength(0);
    expect(peekSystemEventEntries("agent:wecom:user-99")).toHaveLength(0);

    // Fire SessionEnd → DONE.
    await hookRoute!.handler(
      mockReq({
        hook_event_name: "SessionEnd",
        session_id: sid,
        last_assistant_message: "WeCom user's task is done",
      }),
      mockRes(),
    );

    // All notifications route to default hub (agent:main:main in this fixture).
    const hubEntries = peekSystemEventEntries("agent:main:main");
    expect(hubEntries).toHaveLength(1);
    expect(hubEntries[0].contextKey).toBe(`cron:claude-code:${sid}`);
    expect(hubEntries[0].text).toContain("WeCom user's task is done");
    expect(hubEntries[0].deliveryContext).toEqual({
      channel: "wecom",
      to: "user-99",
      accountId: "ww-7",
    });

    // Heartbeat wakes the hub session (defaultNotifySessionKey).
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]).toMatchObject({
      source: "hook",
      intent: "immediate",
      sessionKey: "agent:main:main",
      agentId: "main",
      reason: `claude-code:${sid}:DONE`,
    });
  });

  it("falls back to defaultNotifySessionKey when SessionState has no notify routing", async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-plugin-e2e-"));
    const heartbeats: Array<Record<string, unknown>> = [];
    const { api, routes, waitForServices } = buildApi({
      stateDir,
      defaultNotifySessionKey: "agent:notifications:claude-code",
      heartbeats,
    });

    entry.register!(api as never);
    await waitForServices();
    const hookRoute = routes.find((r) => r.path === "/claude-code/hook");
    expect(hookRoute).toBeDefined();

    // Fire a hook for a never-spawned session — no pre-seeded state file. The
    // session materializes on first hook with no notify routing → falls back to default.
    await hookRoute!.handler(
      mockReq({
        hook_event_name: "SessionEnd",
        session_id: "e2e-default-fallback",
        last_assistant_message: "anonymous task done",
      }),
      mockRes(),
    );

    const entries = peekSystemEventEntries("agent:notifications:claude-code");
    expect(entries).toHaveLength(1);
    expect(entries[0].contextKey).toBe("cron:claude-code:e2e-default-fallback");
    expect(entries[0].deliveryContext).toBeUndefined();

    // Default test fixture's "agent:main:main" must not receive this event.
    expect(peekSystemEventEntries("agent:main:main")).toHaveLength(0);

    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]).toMatchObject({
      source: "hook",
      intent: "immediate",
      sessionKey: "agent:notifications:claude-code",
      agentId: "notifications",
      reason: "claude-code:e2e-default-fallback:DONE",
    });
  });
});
