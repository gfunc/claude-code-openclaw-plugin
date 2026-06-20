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
    await new Promise((r) => setTimeout(r, 50));
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
});
