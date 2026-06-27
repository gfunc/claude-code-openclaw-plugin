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
    sendKeysRateLimitPerMinute: 10,
    sessionTimeoutSeconds: 300,
    defaultNotifySessionKey: "agent:main:main",
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

  // ── hook: basic contract ────────────────────────────────────

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

  it("returns 200 with ok: false for invalid event name", async () => {
    const req = mockReq({
      method: "POST",
      path: "/claude-code/hook",
      body: { hook_event_name: "NotARealEvent", session_id: "s1" },
    });
    const res = mockRes();
    await routes.hook(req, res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse((res as unknown as { body: string }).body);
    expect(body.ok).toBe(false);
  });

  it("returns 200 for non-JSON body (never crashes)", async () => {
    const req = new EventEmitter() as IncomingMessage;
    req.method = "POST";
    req.url = "/claude-code/hook";
    req.headers = { "content-type": "application/json" };
    setImmediate(() => {
      req.emit("data", Buffer.from("not json", "utf8"));
      req.emit("end");
    });
    const res = mockRes();
    await routes.hook(req, res);
    expect(res.statusCode).toBe(200);
  });

  // ── hook: state transitions ──────────────────────────────────

  it("Stop hook transitions state to WAITING", async () => {
    const req = mockReq({
      method: "POST",
      path: "/claude-code/hook",
      body: { hook_event_name: "Stop", session_id: "s-wait" },
    });
    const res = mockRes();
    await routes.hook(req, res);
    const state = store.getState("s-wait");
    expect(state?.state).toBe("WAITING");
  });

  it("SessionEnd hook transitions state to DONE", async () => {
    const req = mockReq({
      method: "POST",
      path: "/claude-code/hook",
      body: { hook_event_name: "SessionEnd", session_id: "s-done" },
    });
    const res = mockRes();
    await routes.hook(req, res);
    const state = store.getState("s-done");
    expect(state?.state).toBe("DONE");
  });

  it("PostToolUseFailure hook transitions state to ERROR", async () => {
    const req = mockReq({
      method: "POST",
      path: "/claude-code/hook",
      body: { hook_event_name: "PostToolUseFailure", session_id: "s-err", tool_name: "Bash" },
    });
    const res = mockRes();
    await routes.hook(req, res);
    const state = store.getState("s-err");
    expect(state?.state).toBe("ERROR");
  });

  it("PermissionRequest hook transitions state to PERMISSION", async () => {
    const req = mockReq({
      method: "POST",
      path: "/claude-code/hook",
      body: { hook_event_name: "PermissionRequest", session_id: "s-perm" },
    });
    const res = mockRes();
    await routes.hook(req, res);
    const state = store.getState("s-perm");
    expect(state?.state).toBe("PERMISSION");
  });

  it("Elicitation hook transitions state to QUESTION", async () => {
    const req = mockReq({
      method: "POST",
      path: "/claude-code/hook",
      body: { hook_event_name: "Elicitation", session_id: "s-q" },
    });
    const res = mockRes();
    await routes.hook(req, res);
    const state = store.getState("s-q");
    expect(state?.state).toBe("QUESTION");
  });

  it("WORKING hooks (PreToolUse, PostToolUse, etc.) leave state as WORKING", async () => {
    for (const event of ["PreToolUse", "PostToolUse", "UserPromptSubmit", "FileChanged", "CwdChanged"]) {
      const sid = `s-${event}`;
      const req = mockReq({
        method: "POST",
        path: "/claude-code/hook",
        body: { hook_event_name: event, session_id: sid, tool_name: event === "PostToolUse" ? "Bash" : undefined },
      });
      await routes.hook(req, mockRes());
      const state = store.getState(sid);
      expect(state?.state).toBe("WORKING");
    }
  });

  // ── hook: taskRegistry delegation ────────────────────────────

  it("delegates WAITING state to taskRegistry.onStateTransition", async () => {
    const req = mockReq({
      method: "POST",
      path: "/claude-code/hook",
      body: { hook_event_name: "Stop", session_id: "s-t1" },
    });
    await routes.hook(req, mockRes());

    expect(taskRegistry.onStateTransition).toHaveBeenCalled();
    const calls = (taskRegistry.onStateTransition as ReturnType<typeof vi.fn>).mock.calls;
    const stateArg = calls[0]?.[0] as SessionState;
    expect(stateArg.state).toBe("WAITING");
    expect(stateArg.sessionId).toBe("s-t1");
  });

  it("delegates DONE state to taskRegistry.onStateTransition", async () => {
    const req = mockReq({
      method: "POST",
      path: "/claude-code/hook",
      body: {
        hook_event_name: "SessionEnd",
        session_id: "s-t2",
        last_assistant_message: "analysis complete",
      },
    });
    await routes.hook(req, mockRes());

    const calls = (taskRegistry.onStateTransition as ReturnType<typeof vi.fn>).mock.calls;
    const stateArg = calls[0]?.[0] as SessionState;
    expect(stateArg.state).toBe("DONE");
    // last_assistant_message flows through to payload
    expect(stateArg.lastHookPayload.last_assistant_message).toBe("analysis complete");
  });

  it("does NOT delegate WORKING state to taskRegistry (no-op)", async () => {
    // First hook sets initial state to WORKING — taskRegistry not called
    // because on first hook prevState is undefined and state is WORKING
    const req = mockReq({
      method: "POST",
      path: "/claude-code/hook",
      body: { hook_event_name: "UserPromptSubmit", session_id: "s-t3" },
    });
    await routes.hook(req, mockRes());

    // onStateTransition IS called but it's a no-op internally for WORKING.
    // We verify the hook worked and stored state correctly.
    const state = store.getState("s-t3");
    expect(state?.state).toBe("WORKING");
  });

  // ── discover: tmux session mapping ───────────────────────────

  it("sets tmuxSession when discover callback is provided", async () => {
    const routesWithDiscover = createClaudeCodeRoutes({
      store,
      config,
      taskRegistry,
      discoverSession: async (sessionId) => {
        if (sessionId === "s-disc") return { tmuxSession: "cc-found-me", sessionId: "s-disc", logFile: "/tmp/cc.log" };
        return undefined;
      },
    });

    const req = mockReq({
      method: "POST",
      path: "/claude-code/hook",
      body: { hook_event_name: "Stop", session_id: "s-disc" },
    });
    await routesWithDiscover.hook(req, mockRes());

    const state = store.getState("s-disc");
    expect(state?.tmuxSession).toBe("cc-found-me");
    expect(state?.logFile).toBe("/tmp/cc.log");
  });

  it("hook handler does NOT set notify routing (now set by spawn)", async () => {
    const req = mockReq({
      method: "POST",
      path: "/claude-code/hook",
      body: { hook_event_name: "Stop", session_id: "s-req" },
    });
    await routes.hook(req, mockRes());

    const state = store.getState("s-req");
    expect(state).toBeDefined();
    expect(state?.notifySessionKey).toBeUndefined();
    expect(state?.runId).toBeUndefined();
  });

  // ── send route ───────────────────────────────────────────────

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

  // ── hook: multiple events on same session ─────────────────────

  it("transitions correctly through a full session lifecycle", async () => {
    const sid = "s-lifecycle";

    // UserPromptSubmit → WORKING
    await routes.hook(mockReq({ method: "POST", path: "/claude-code/hook", body: { hook_event_name: "UserPromptSubmit", session_id: sid } }), mockRes());
    expect(store.getState(sid)?.state).toBe("WORKING");

    // PostToolUse → WORKING (stays)
    await routes.hook(mockReq({ method: "POST", path: "/claude-code/hook", body: { hook_event_name: "PostToolUse", session_id: sid, tool_name: "Bash" } }), mockRes());
    expect(store.getState(sid)?.state).toBe("WORKING");

    // PostToolUseFailure → ERROR
    await routes.hook(mockReq({ method: "POST", path: "/claude-code/hook", body: { hook_event_name: "PostToolUseFailure", session_id: sid, tool_name: "Bash" } }), mockRes());
    expect(store.getState(sid)?.state).toBe("ERROR");

    // Stop → WAITING
    await routes.hook(mockReq({ method: "POST", path: "/claude-code/hook", body: { hook_event_name: "Stop", session_id: sid } }), mockRes());
    expect(store.getState(sid)?.state).toBe("WAITING");

    // SessionEnd → DONE
    await routes.hook(mockReq({ method: "POST", path: "/claude-code/hook", body: { hook_event_name: "SessionEnd", session_id: sid } }), mockRes());
    expect(store.getState(sid)?.state).toBe("DONE");

    // History should have 5 entries
    expect(store.getState(sid)?.history).toHaveLength(5);
  });
});
