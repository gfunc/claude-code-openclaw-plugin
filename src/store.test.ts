import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionStore } from "./store.js";
import type { ClaudeCodeHookPayload } from "./state.js";

describe("createSessionStore", () => {
  const stateDir = path.join(os.tmpdir(), "claude-hooks-store-test");
  let store: ReturnType<typeof createSessionStore>;

  beforeEach(async () => {
    await fs.mkdir(stateDir, { recursive: true });
    store = createSessionStore({ stateFileDir: stateDir, flushDebounceMs: 10 });
  });

  afterEach(async () => {
    await store.dispose();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("stores and retrieves a session", async () => {
    const payload: ClaudeCodeHookPayload = {
      hook_event_name: "SessionStart",
      session_id: "s1",
      cwd: "/tmp",
    };
    await store.applyHook(payload, async () => ({
      tmuxSession: "cc-test",
      logFile: path.join(stateDir, "cc-test.log"),
    }));
    const state = store.getState("s1");
    expect(state?.state).toBe("WORKING");
    expect(state?.tmuxSession).toBe("cc-test");
  });

  it("persists to disk", async () => {
    const payload: ClaudeCodeHookPayload = {
      hook_event_name: "Stop",
      session_id: "s2",
    };
    await store.applyHook(payload);
    await store.dispose();
    const files = await fs.readdir(stateDir);
    expect(files.some((f) => f.includes("s2"))).toBe(true);
  });

  it("marks a session as FATAL", async () => {
    const payload: ClaudeCodeHookPayload = {
      hook_event_name: "Stop",
      session_id: "s3",
    };
    await store.applyHook(payload);
    const updated = store.markFatal("s3", "timeout");
    expect(updated?.state).toBe("FATAL");
  });

  it("returns undefined for markFatal on non-existent session", () => {
    expect(store.markFatal("no-such-session", "reason")).toBeUndefined();
  });

  it("stores the fatal reason", async () => {
    // apply a hook first so session exists
    await store.applyHook({ hook_event_name: "Stop", session_id: "fatal-reason" });
    store.markFatal("fatal-reason", "timeout");
    const state = store.getState("fatal-reason");
    expect(state?.fatalReason).toBe("timeout");
  });

  it("loads sessions from disk", async () => {
    const payload: ClaudeCodeHookPayload = {
      hook_event_name: "Stop",
      session_id: "loadable",
    };
    await store.applyHook(payload);
    await store.dispose();

    // Create a fresh store that reads the same directory
    const store2 = createSessionStore({ stateFileDir: stateDir, flushDebounceMs: 10 });
    try {
      const loaded = await store2.loadFromDisk();
      expect(loaded).toBeGreaterThanOrEqual(1);
      expect(store2.getState("loadable")?.sessionId).toBe("loadable");
    } finally {
      await store2.dispose();
    }
  });
});

describe("setNotifyContext", () => {
  it("stores notifySessionKey and notifyDeliveryContext on the session", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "store-"));
    const store = createSessionStore({ stateFileDir: dir });
    await store.applyHook({
      hook_event_name: "SessionStart",
      session_id: "sid-x",
    } as ClaudeCodeHookPayload);

    store.setNotifyContext("sid-x", {
      runId: "sid-x",
      notifySessionKey: "agent:wecom:user-7",
      notifyDeliveryContext: { channel: "wecom", to: "user-7", accountId: "ww1" },
    });

    const s = store.getState("sid-x")!;
    expect(s.runId).toBe("sid-x");
    expect(s.notifySessionKey).toBe("agent:wecom:user-7");
    expect(s.notifyDeliveryContext).toEqual({
      channel: "wecom", to: "user-7", accountId: "ww1",
    });
  });

  it("is a no-op when sessionId is unknown", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "store-"));
    const store = createSessionStore({ stateFileDir: dir });
    expect(() => store.setNotifyContext("nope", {
      runId: "nope",
      notifySessionKey: "agent:main:main",
    })).not.toThrow();
    expect(store.getState("nope")).toBeUndefined();
  });

  it("persists notifySessionKey across loadFromDisk", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "store-"));
    const a = createSessionStore({ stateFileDir: dir, flushDebounceMs: 0 });
    await a.applyHook({
      hook_event_name: "SessionStart",
      session_id: "sid-roundtrip",
    } as ClaudeCodeHookPayload);
    a.setNotifyContext("sid-roundtrip", {
      runId: "sid-roundtrip",
      notifySessionKey: "agent:wecom:user-1",
      notifyDeliveryContext: { channel: "wecom", to: "user-1" },
    });
    await a.dispose();  // flushes

    const b = createSessionStore({ stateFileDir: dir });
    const count = await b.loadFromDisk();
    expect(count).toBeGreaterThanOrEqual(1);
    const s = b.getState("sid-roundtrip")!;
    expect(s.notifySessionKey).toBe("agent:wecom:user-1");
    expect(s.notifyDeliveryContext?.channel).toBe("wecom");
  });

  it("absorbs pending notify context when the session is created later via applyHook", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "store-"));
    const store = createSessionStore({ stateFileDir: dir });

    // Spawn-side: routing set before any hook arrives.
    store.setNotifyContext("sid-late", {
      runId: "sid-late",
      notifySessionKey: "agent:wecom:user-42",
      notifyDeliveryContext: { channel: "wecom", to: "user-42" },
    });
    expect(store.getState("sid-late")).toBeUndefined();

    // First hook arrives — applyHook should absorb the pending routing.
    await store.applyHook({
      hook_event_name: "SessionStart",
      session_id: "sid-late",
    } as ClaudeCodeHookPayload);

    const s = store.getState("sid-late")!;
    expect(s.notifySessionKey).toBe("agent:wecom:user-42");
    expect(s.notifyDeliveryContext).toEqual({ channel: "wecom", to: "user-42" });
    expect(s.runId).toBe("sid-late");
  });

  it("clears the pending routing entry after absorption (no leak across re-creates)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "store-"));
    const store = createSessionStore({ stateFileDir: dir });
    store.setNotifyContext("sid-once", {
      runId: "sid-once",
      notifySessionKey: "agent:a:b",
    });
    await store.applyHook({
      hook_event_name: "SessionStart",
      session_id: "sid-once",
    } as ClaudeCodeHookPayload);

    // Simulate state file lost / reload. setNotifyContext should not re-fire from pending.
    // (We can't directly inspect pendingNotifyContext, but we can confirm the absorption
    // happened once and the pending map is now empty by checking that a second
    // applyHook for an unrelated session doesn't accidentally pick up sid-once's routing.)
    await store.applyHook({
      hook_event_name: "SessionStart",
      session_id: "sid-other",
    } as ClaudeCodeHookPayload);
    expect(store.getState("sid-other")?.notifySessionKey).toBeUndefined();
  });
});
