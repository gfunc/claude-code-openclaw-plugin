import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionStore } from "./store.js";
import { createClaudeCodeRoutes } from "./routes.js";
import type { PluginConfig } from "./config.js";
import type { SessionState } from "./state.js";

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
  let onHookTransition: ReturnType<typeof vi.fn>;
  const config: PluginConfig = {
    routePrefix: "/claude-code",
    eventTypes: ["*"],
    sessionTimeoutSeconds: 300,
    stateFileDir: "/tmp/routes-test",
    debugLog: false,
    acpBudgetMinutes: 30,
    acpPermissionMode: "bypassPermissions",
    acpAllowedTools: [],
    acpBackendId: "claude-code",
  };

  beforeEach(() => {
    store = createSessionStore({ stateFileDir: "/tmp/routes-test" });
    onHookTransition = vi.fn();
    routes = createClaudeCodeRoutes({
      store,
      config,
      onHookTransition,
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

  // ── hook: onHookTransition callback ─────────────────────────

  it("calls onHookTransition on state transition", async () => {
    const req = mockReq({
      method: "POST",
      path: "/claude-code/hook",
      body: { hook_event_name: "Stop", session_id: "s-t1" },
    });
    await routes.hook(req, mockRes());

    expect(onHookTransition).toHaveBeenCalled();
    const stateArg = onHookTransition.mock.calls[0]?.[0] as SessionState;
    expect(stateArg.state).toBe("WAITING");
    expect(stateArg.sessionId).toBe("s-t1");
  });

  it("calls onHookTransition for DONE state", async () => {
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

    const stateArg = onHookTransition.mock.calls[0]?.[0] as SessionState;
    expect(stateArg.state).toBe("DONE");
    expect(stateArg.lastHookPayload.last_assistant_message).toBe("analysis complete");
  });

  it("calls onHookTransition for WORKING initial state", async () => {
    const req = mockReq({
      method: "POST",
      path: "/claude-code/hook",
      body: { hook_event_name: "UserPromptSubmit", session_id: "s-t3" },
    });
    await routes.hook(req, mockRes());

    expect(onHookTransition).toHaveBeenCalled();
    const stateArg = onHookTransition.mock.calls[0]?.[0] as SessionState;
    expect(stateArg.state).toBe("WORKING");
  });

  // ── discover: tmux session mapping ───────────────────────────

  it("sets tmuxSession when discover callback is provided", async () => {
    const routesWithDiscover = createClaudeCodeRoutes({
      store,
      config,
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
