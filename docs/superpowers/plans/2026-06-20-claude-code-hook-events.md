# Claude Code Hook Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `claude-code-openclaw-plugin` to receive deterministic Claude Code lifecycle hook events on the OpenClaw gateway, track session state in memory + on disk, expose status to OpenClaw agents, and support `tmux send-keys` command injection.

**Architecture:** The plugin switches from `defineToolPlugin` to `definePluginEntry`, registers `auth: "plugin"` HTTP routes on the existing gateway, keeps a hot in-memory state cache backed by async disk flushes, injects session status into agent context via the `before_prompt_build` hook, and wakes the heartbeat when a notify-worthy state is reached.

**Tech Stack:** TypeScript, Node 20+, OpenClaw plugin SDK, Zod (config validation), TypeBox (tool schemas), Vitest.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/index.ts` | Plugin entry point: wires routes, hooks, service, and tools. |
| `src/config.ts` | Runtime config schema, validation, and types. |
| `src/state.ts` | State types and pure state-derivation logic. |
| `src/store.ts` | In-memory session store with async disk flush and reload. |
| `src/discovery.ts` | Discover tmux session / log file from `claude-task` state files. |
| `src/hook.ts` | Parse and validate Claude Code hook payloads. |
| `src/routes.ts` | HTTP route handlers for `/claude-code/hook` and `/claude-code/:tmuxSession/send`. |
| `src/tmux.ts` | Escape and execute `tmux send-keys`. |
| `src/context.ts` | Build `before_prompt_build` context snippet from active sessions. |
| `src/tools.ts` | `claude_code_status` tool for agent-initiated queries. |
| `.claude/settings.json` | Project-level Claude Code hook configuration. |
| `openclaw.plugin.json` | Manifest update to allow plugin config. |
| `package.json` | Add `zod` dependency and update build/test scripts if needed. |
| `src/*.test.ts` | Unit and integration tests. |

---

### Task 1: Add `zod` dependency and update manifests

**Files:**
- Modify: `package.json`
- Modify: `openclaw.plugin.json`

**Why:** The plugin needs runtime config validation. OpenClaw's `buildPluginConfigSchema` accepts a Zod schema, and the manifest must allow config properties.

- [ ] **Step 1: Add `zod` to dependencies**

```json
{
  "dependencies": {
    "typebox": "^1.1.38",
    "zod": "^3.25.0"
  }
}
```

Run: `npm install`
Expected: `package-lock.json` updated, `node_modules/zod` exists.

- [ ] **Step 2: Update `openclaw.plugin.json` to allow config**

```json
{
  "id": "claude-code-openclaw-plugin",
  "name": "Claude Code harness",
  "description": "Add Claude Code harness tools to OpenClaw.",
  "version": "0.1.0",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "routePrefix": { "type": "string", "default": "/claude-code" },
      "eventTypes": { "type": "array", "items": { "type": "string" }, "default": ["*"] },
      "stateFileDir": { "type": "string", "default": "~/.cache/claude-code-hooks" },
      "notifyStates": { "type": "array", "items": { "type": "string" }, "default": ["WAITING", "QUESTION", "PERMISSION", "ERROR", "DONE"] },
      "sendKeysRateLimitPerMinute": { "type": "number", "default": 10 },
      "sessionTimeoutSeconds": { "type": "number", "default": 300 }
    }
  },
  "activation": { "onStartup": true },
  "contracts": { "tools": ["claude_code_status"] }
}
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json openclaw.plugin.json
git commit -m "chore: add zod dependency and allow plugin config"
```

---

### Task 2: Create runtime config schema

**Files:**
- Create: `src/config.ts`
- Test: `src/config.test.ts`

**Why:** Centralize and validate plugin configuration so every other module receives a typed, defaulted config object.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { resolvePluginConfig } from "./config.js";

describe("resolvePluginConfig", () => {
  it("applies defaults", () => {
    const cfg = resolvePluginConfig({});
    expect(cfg.routePrefix).toBe("/claude-code");
    expect(cfg.stateFileDir).toBe("~/.cache/claude-code-hooks");
  });

  it("expands tilde in stateFileDir", () => {
    const cfg = resolvePluginConfig({ stateFileDir: "~/tmp/claude-hooks" });
    expect(cfg.stateFileDir).toMatch(/\/tmp\/claude-hooks$/);
  });

  it("rejects invalid notifyStates", () => {
    expect(() => resolvePluginConfig({ notifyStates: ["UNKNOWN"] })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/config.test.ts`
Expected: FAIL — `resolvePluginConfig` not found.

- [ ] **Step 3: Implement minimal config module**

```ts
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const ClaudeCodeState = z.enum([
  "WORKING",
  "WAITING",
  "QUESTION",
  "PERMISSION",
  "ERROR",
  "DONE",
  "FATAL",
]);

export type ClaudeCodeState = z.infer<typeof ClaudeCodeState>;

const pluginConfigSchema = z.object({
  routePrefix: z.string().default("/claude-code"),
  eventTypes: z.array(z.string()).default(["*"]),
  stateFileDir: z.string().default("~/.cache/claude-code-hooks"),
  notifyStates: z.array(ClaudeCodeState).default([
    "WAITING",
    "QUESTION",
    "PERMISSION",
    "ERROR",
    "DONE",
  ]),
  sendKeysRateLimitPerMinute: z.number().int().positive().default(10),
  sessionTimeoutSeconds: z.number().int().positive().default(300),
});

export type PluginConfig = z.infer<typeof pluginConfigSchema>;

function expandTilde(input: string): string {
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function resolvePluginConfig(raw: unknown): PluginConfig {
  const parsed = pluginConfigSchema.parse(raw);
  return {
    ...parsed,
    stateFileDir: expandTilde(parsed.stateFileDir),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: add plugin config schema and validation"
```

---

### Task 3: Define session state and derivation rules

**Files:**
- Create: `src/state.ts`
- Test: `src/state.test.ts`

**Why:** Keep state logic pure, deterministic, and easy to unit test.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { deriveState, type ClaudeCodeHookPayload } from "./state.js";

describe("deriveState", () => {
  it("maps PreToolUse to WORKING", () => {
    const result = deriveState({ hook_event_name: "PreToolUse", session_id: "s1" });
    expect(result.state).toBe("WORKING");
  });

  it("maps Stop with no prompt to WAITING", () => {
    const result = deriveState({ hook_event_name: "Stop", session_id: "s1" });
    expect(result.state).toBe("WAITING");
  });

  it("maps PermissionRequest to PERMISSION", () => {
    const result = deriveState({ hook_event_name: "PermissionRequest", session_id: "s1" });
    expect(result.state).toBe("PERMISSION");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/state.test.ts`
Expected: FAIL — `deriveState` not found.

- [ ] **Step 3: Implement state module**

```ts
import type { ClaudeCodeState } from "./config.js";

export type ClaudeCodeHookName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "Stop"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PermissionRequest"
  | "FileChanged"
  | "CwdChanged";

export type ClaudeCodeHookPayload = {
  hook_event_name: ClaudeCodeHookName;
  session_id: string;
  cwd?: string;
  transcript_path?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: unknown;
  [key: string]: unknown;
};

export type SessionState = {
  sessionId: string;
  tmuxSession?: string;
  openclawSessionKey?: string;
  workdir?: string;
  logFile?: string;
  state: ClaudeCodeState;
  lastHookEvent: ClaudeCodeHookName;
  lastHookPayload: ClaudeCodeHookPayload;
  stateSince: number;
  lastSeenAt: number;
  budgetMinutes?: number;
  budgetDeadline?: number;
  history: Array<{
    ts: number;
    state: ClaudeCodeState;
    event: ClaudeCodeHookName;
    tool?: string;
  }>;
};

export function deriveState(payload: ClaudeCodeHookPayload): {
  state: ClaudeCodeState;
  tool?: string;
} {
  switch (payload.hook_event_name) {
    case "SessionStart":
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
    case "FileChanged":
    case "CwdChanged":
      return { state: "WORKING", tool: payload.tool_name };
    case "PostToolUseFailure":
      return { state: "ERROR", tool: payload.tool_name };
    case "PermissionRequest":
      return { state: "PERMISSION" };
    case "SessionEnd":
      return { state: "DONE" };
    case "Stop":
    default:
      return { state: "WAITING" };
  }
}

export function buildInitialState(payload: ClaudeCodeHookPayload): SessionState {
  const now = Date.now();
  const { state, tool } = deriveState(payload);
  return {
    sessionId: payload.session_id,
    workdir: payload.cwd,
    state,
    lastHookEvent: payload.hook_event_name,
    lastHookPayload: payload,
    stateSince: now,
    lastSeenAt: now,
    history: [{ ts: now, state, event: payload.hook_event_name, tool }],
  };
}

export function applyHook(
  current: SessionState,
  payload: ClaudeCodeHookPayload,
): SessionState {
  const now = Date.now();
  const { state, tool } = deriveState(payload);
  const isNewState = current.state !== state;
  return {
    ...current,
    workdir: payload.cwd ?? current.workdir,
    state,
    lastHookEvent: payload.hook_event_name,
    lastHookPayload: payload,
    stateSince: isNewState ? now : current.stateSince,
    lastSeenAt: now,
    history: [
      ...current.history,
      { ts: now, state, event: payload.hook_event_name, tool },
    ],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts src/state.test.ts
git commit -m "feat: add session state types and derivation rules"
```

---

### Task 4: Discover tmux session from `claude-task` state files

**Files:**
- Create: `src/discovery.ts`
- Test: `src/discovery.test.ts`

**Why:** Claude Code hook payloads include `session_id` but not the tmux session name. `claude-task` already writes `~/.cache/claude-tasks/<session>.state` containing `session_id=...`, so we scan it.

- [ ] **Step 1: Write the failing test**

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSession } from "./discovery.js";

describe("discoverSession", () => {
  const baseDir = path.join(os.tmpdir(), "claude-hooks-discovery-test");

  beforeEach(async () => {
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(
      path.join(baseDir, "cc-bugfix.state"),
      "RUNNING 1750435200 budget=30min workdir=/home/georgefu/Projects/uco session_id=s1\n",
    );
    await fs.writeFile(path.join(baseDir, "cc-bugfix.log"), "log line\n");
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("finds tmux session and log file by session id", async () => {
    const found = await discoverSession({ sessionId: "s1", tasksDir: baseDir });
    expect(found?.tmuxSession).toBe("cc-bugfix");
    expect(found?.logFile).toBe(path.join(baseDir, "cc-bugfix.log"));
  });

  it("returns undefined when not found", async () => {
    const found = await discoverSession({ sessionId: "missing", tasksDir: baseDir });
    expect(found).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/discovery.test.ts`
Expected: FAIL — `discoverSession` not found.

- [ ] **Step 3: Implement discovery module**

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type DiscoveredSession = {
  tmuxSession: string;
  logFile: string;
  workdir?: string;
  budgetMinutes?: number;
};

export async function discoverSession({
  sessionId,
  tasksDir = path.join(os.homedir(), ".cache", "claude-tasks"),
}: {
  sessionId: string;
  tasksDir?: string;
}): Promise<DiscoveredSession | undefined> {
  const entries = await fs.readdir(tasksDir).catch(() => []);
  for (const entry of entries) {
    if (!entry.endsWith(".state")) continue;
    const tmuxSession = entry.slice(0, -".state".length);
    const statePath = path.join(tasksDir, entry);
    const content = await fs.readFile(statePath, "utf8").catch(() => "");
    const match = content.match(/session_id=([a-f0-9-]+)/);
    if (match?.[1] === sessionId) {
      const workdirMatch = content.match(/workdir=(\S+)/);
      const budgetMatch = content.match(/budget=(\d+)min/);
      return {
        tmuxSession,
        logFile: path.join(tasksDir, `${tmuxSession}.log`),
        workdir: workdirMatch?.[1],
        budgetMinutes: budgetMatch ? parseInt(budgetMatch[1], 10) : undefined,
      };
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/discovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/discovery.ts src/discovery.test.ts
git commit -m "feat: discover tmux session from claude-task state files"
```

---

### Task 5: Parse Claude Code hook payloads

**Files:**
- Create: `src/hook.ts`
- Test: `src/hook.test.ts`

**Why:** Validate incoming hook JSON and coerce it into the internal payload type.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { parseHookPayload } from "./hook.js";

describe("parseHookPayload", () => {
  it("accepts a valid PreToolUse payload", () => {
    const payload = parseHookPayload({
      hook_event_name: "PreToolUse",
      session_id: "s1",
      cwd: "/tmp",
      tool_name: "Bash",
    });
    expect(payload.hook_event_name).toBe("PreToolUse");
    expect(payload.session_id).toBe("s1");
  });

  it("rejects missing session_id", () => {
    expect(() => parseHookPayload({ hook_event_name: "Stop" })).toThrow();
  });

  it("rejects unknown event names", () => {
    expect(() =>
      parseHookPayload({ hook_event_name: "UnknownEvent", session_id: "s1" }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/hook.test.ts`
Expected: FAIL — `parseHookPayload` not found.

- [ ] **Step 3: Implement hook parser**

```ts
import { z } from "zod";
import type { ClaudeCodeHookName, ClaudeCodeHookPayload } from "./state.js";

const hookNameSchema = z.enum([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "FileChanged",
  "CwdChanged",
]);

const hookPayloadSchema = z.object({
  hook_event_name: hookNameSchema,
  session_id: z.string().uuid(),
  cwd: z.string().optional(),
  transcript_path: z.string().optional(),
  permission_mode: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
});

export type RawHookPayload = z.infer<typeof hookPayloadSchema>;

export function parseHookPayload(raw: unknown): ClaudeCodeHookPayload {
  const parsed = hookPayloadSchema.parse(raw);
  return parsed as ClaudeCodeHookPayload;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/hook.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hook.ts src/hook.test.ts
git commit -m "feat: parse and validate Claude Code hook payloads"
```

---

### Task 6: Build in-memory session store with async disk flush

**Files:**
- Create: `src/store.ts`
- Test: `src/store.test.ts`

**Why:** Hot state lives in memory for performance; disk is only for startup recovery and cross-process visibility.

- [ ] **Step 1: Write the failing test**

```ts
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
    store = createSessionStore({ stateDir, flushDebounceMs: 10 });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/store.test.ts`
Expected: FAIL — `createSessionStore` not found.

- [ ] **Step 3: Implement store module**

```ts
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginConfig } from "./config.js";
import type { DiscoveredSession } from "./discovery.js";
import type { ClaudeCodeHookPayload, SessionState } from "./state.js";
import { applyHook as applyHookState, buildInitialState } from "./state.js";

export type SessionStoreOptions = Pick<PluginConfig, "stateFileDir"> & {
  flushDebounceMs?: number;
};

export type SessionStore = ReturnType<typeof createSessionStore>;

export function createSessionStore(options: SessionStoreOptions) {
  const stateDir = options.stateFileDir;
  const flushDebounceMs = options.flushDebounceMs ?? 250;
  const sessions = new Map<string, SessionState>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function statePath(sessionId: string): string {
    return path.join(stateDir, `${sessionId}.json`);
  }

  async function flush(): Promise<void> {
    if (disposed) return;
    await fs.mkdir(stateDir, { recursive: true });
    await Promise.all(
      Array.from(sessions.values()).map((state) => {
        const file = statePath(state.sessionId);
        return fs.writeFile(file, JSON.stringify(state, null, 2) + "\n", "utf8");
      }),
    );
  }

  function scheduleFlush(): void {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      void flush();
    }, flushDebounceMs);
  }

  async function applyHook(
    payload: ClaudeCodeHookPayload,
    discover?: () => Promise<DiscoveredSession | undefined>,
  ): Promise<SessionState> {
    let state = sessions.get(payload.session_id);
    if (!state) {
      state = buildInitialState(payload);
      const found = discover ? await discover() : undefined;
      if (found) {
        state.tmuxSession = found.tmuxSession;
        state.logFile = found.logFile;
        state.workdir = found.workdir ?? state.workdir;
        state.budgetMinutes = found.budgetMinutes;
        if (found.budgetMinutes) {
          state.budgetDeadline = Date.now() + found.budgetMinutes * 60_000;
        }
      }
      sessions.set(payload.session_id, state);
    } else {
      state = applyHookState(state, payload);
      sessions.set(payload.session_id, state);
    }
    scheduleFlush();
    return state;
  }

  function markFatal(sessionId: string, reason: string): SessionState | undefined {
    const state = sessions.get(sessionId);
    if (!state || state.state === "FATAL") return state;
    const now = Date.now();
    const updated: SessionState = {
      ...state,
      state: "FATAL",
      stateSince: now,
      lastSeenAt: now,
      history: [...state.history, { ts: now, state: "FATAL", event: state.lastHookEvent }],
    };
    sessions.set(sessionId, updated);
    scheduleFlush();
    return updated;
  }

  function getState(sessionId: string): SessionState | undefined {
    return sessions.get(sessionId);
  }

  function listStates(): SessionState[] {
    return Array.from(sessions.values());
  }

  async function dispose(): Promise<void> {
    disposed = true;
    if (flushTimer) clearTimeout(flushTimer);
    await flush();
  }

  return {
    applyHook,
    markFatal,
    getState,
    listStates,
    dispose,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/store.test.ts
git commit -m "feat: in-memory session store with async disk flush"
```

---

### Task 7: Escape and execute `tmux send-keys`

**Files:**
- Create: `src/tmux.ts`
- Test: `src/tmux.test.ts`

**Why:** Bidirectional control is implemented by sending literal keys into the tracked tmux session.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { sendKeysToTmuxSession } from "./tmux.js";

describe("sendKeysToTmuxSession", () => {
  it("runs tmux send-keys with literal text", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    await sendKeysToTmuxSession({ tmuxSession: "cc-test", text: "hello", submit: false, exec });
    expect(exec).toHaveBeenCalledWith("tmux", ["send-keys", "-t", "cc-test", "-l", "hello"]);
  });

  it("appends Enter when submit is true", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    await sendKeysToTmuxSession({ tmuxSession: "cc-test", text: "yes", submit: true, exec });
    expect(exec).toHaveBeenCalledWith("tmux", ["send-keys", "-t", "cc-test", "-l", "yes", "Enter"]);
  });

  it("rejects tmux control characters in literal mode input", async () => {
    const exec = vi.fn();
    await expect(
      sendKeysToTmuxSession({ tmuxSession: "cc-test", text: "foo\x1bbar", submit: false, exec }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/tmux.test.ts`
Expected: FAIL — `sendKeysToTmuxSession` not found.

- [ ] **Step 3: Implement tmux helper**

```ts
import { runCommandWithTimeout } from "openclaw/plugin-sdk/plugin-runtime";

export type ExecFn = typeof runCommandWithTimeout;

export async function sendKeysToTmuxSession({
  tmuxSession,
  text,
  submit,
  exec = runCommandWithTimeout,
}: {
  tmuxSession: string;
  text: string;
  submit: boolean;
  exec?: ExecFn;
}): Promise<void> {
  // literal mode (-l) still passes bytes through; reject escape/control sequences.
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) {
    throw new Error("tmux send-keys text contains control characters");
  }
  const args = ["send-keys", "-t", tmuxSession, "-l", text];
  if (submit) {
    args.push("Enter");
  }
  const result = await exec("tmux", args, { timeoutMs: 5000 });
  if (result.exitCode !== 0) {
    throw new Error(`tmux send-keys failed: ${result.stderr}`);
  }
}

export async function tmuxSessionExists(tmuxSession: string): Promise<boolean> {
  const result = await runCommandWithTimeout("tmux", ["has-session", "-t", tmuxSession], {
    timeoutMs: 2000,
  });
  return result.exitCode === 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/tmux.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tmux.ts src/tmux.test.ts
git commit -m "feat: tmux send-keys helper with literal mode escaping"
```

---

### Task 8: Build `before_prompt_build` context snippet

**Files:**
- Create: `src/context.ts`
- Test: `src/context.test.ts`

**Why:** OpenClaw agents learn about active Claude Code sessions through injected context, not a push event bus.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildClaudeCodeContext } from "./context.js";
import type { SessionState } from "./state.js";

describe("buildClaudeCodeContext", () => {
  it("includes notify-worthy sessions", () => {
    const sessions: SessionState[] = [
      {
        sessionId: "s1",
        tmuxSession: "cc-bugfix",
        state: "WAITING",
        lastHookEvent: "Stop",
        lastHookPayload: { hook_event_name: "Stop", session_id: "s1" },
        stateSince: Date.now() - 5000,
        lastSeenAt: Date.now(),
        history: [],
      },
    ];
    const ctx = buildClaudeCodeContext({ sessions, notifyStates: ["WAITING", "ERROR"] });
    expect(ctx).toContain("cc-bugfix");
    expect(ctx).toContain("WAITING");
  });

  it("omits WORKING sessions", () => {
    const sessions: SessionState[] = [
      {
        sessionId: "s2",
        tmuxSession: "cc-other",
        state: "WORKING",
        lastHookEvent: "PreToolUse",
        lastHookPayload: { hook_event_name: "PreToolUse", session_id: "s2" },
        stateSince: Date.now(),
        lastSeenAt: Date.now(),
        history: [],
      },
    ];
    const ctx = buildClaudeCodeContext({ sessions, notifyStates: ["WAITING"] });
    expect(ctx).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/context.test.ts`
Expected: FAIL — `buildClaudeCodeContext` not found.

- [ ] **Step 3: Implement context builder**

```ts
import type { ClaudeCodeState } from "./config.js";
import type { SessionState } from "./state.js";

export function buildClaudeCodeContext({
  sessions,
  notifyStates,
}: {
  sessions: SessionState[];
  notifyStates: ClaudeCodeState[];
}): string {
  const relevant = sessions.filter((s) => notifyStates.includes(s.state));
  if (relevant.length === 0) return "";
  const lines = ["## Active Claude Code sessions"];
  for (const s of relevant) {
    lines.push(`- tmux: ${s.tmuxSession ?? "unknown"} | state: ${s.state} | since: ${new Date(s.stateSince).toISOString()}`);
    if (s.workdir) lines.push(`  workdir: ${s.workdir}`);
    if (s.budgetDeadline) lines.push(`  budget deadline: ${new Date(s.budgetDeadline).toISOString()}`);
    if (s.logFile) lines.push(`  log: ${s.logFile}`);
  }
  lines.push("");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/context.ts src/context.test.ts
git commit -m "feat: build before_prompt_build context from active sessions"
```

---

### Task 9: Implement HTTP route handlers

**Files:**
- Create: `src/routes.ts`
- Test: `src/routes.test.ts`

**Why:** The plugin exposes `/claude-code/hook` for Claude Code and `/claude-code/:tmuxSession/send` for OpenClaw control.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/routes.test.ts`
Expected: FAIL — `createClaudeCodeRoutes` not found.

- [ ] **Step 3: Implement route module**

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginConfig } from "./config.js";
import { parseHookPayload } from "./hook.js";
import type { SessionStore } from "./store.js";

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createClaudeCodeRoutes({
  store,
  config,
  requestHeartbeatNow,
  sendKeys,
  discoverSession,
}: {
  store: SessionStore;
  config: PluginConfig;
  requestHeartbeatNow?: () => void;
  sendKeys?: (params: {
    tmuxSession: string;
    text: string;
    submit: boolean;
  }) => Promise<void>;
  discoverSession?: (sessionId: string) => Promise<{ tmuxSession: string; logFile: string; workdir?: string; budgetMinutes?: number } | undefined>;
}) {
  async function hook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const payload = parseHookPayload(body);
      const state = await store.applyHook(payload, async () => discoverSession?.(payload.session_id));
      if (config.notifyStates.includes(state.state)) {
        requestHeartbeatNow?.();
      }
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: String(err) });
    }
  }

  async function send(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const suffix = req.url?.slice(config.routePrefix.length) ?? "";
    const match = suffix.match(/^\/([^/]+)\/send$/);
    const tmuxSession = match?.[1];
    if (!tmuxSession) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const tracked = store
      .listStates()
      .find((s) => s.tmuxSession === tmuxSession);
    if (!tracked) {
      sendJson(res, 404, { error: "session not tracked" });
      return;
    }
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const text = String(body.text ?? "");
      const submit = Boolean(body.submit);
      await sendKeys?.({ tmuxSession, text, submit });
      sendJson(res, 200, { sent: true, sessionId: tracked.sessionId });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
  }

  return { hook, send };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes.ts src/routes.test.ts
git commit -m "feat: HTTP routes for Claude Code hooks and send-keys"
```

---

### Task 10: Add `claude_code_status` agent tool

**Files:**
- Create: `src/tools.ts`
- Test: `src/tools.test.ts`

**Why:** Give OpenClaw agents an on-demand way to query Claude Code session state.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { createClaudeCodeStatusTool } from "./tools.js";
import { createSessionStore } from "./store.js";

describe("claude_code_status tool", () => {
  it("returns active sessions", async () => {
    const store = createSessionStore({ stateFileDir: "/tmp/tools-test" });
    await store.applyHook({ hook_event_name: "Stop", session_id: "s1" });
    const tool = createClaudeCodeStatusTool(store);
    const result = await tool.execute({});
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe("s1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/tools.test.ts`
Expected: FAIL — `createClaudeCodeStatusTool` not found.

- [ ] **Step 3: Implement tool module**

```ts
import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { SessionStore } from "./store.js";

export function createClaudeCodeStatusTool(store: SessionStore): AnyAgentTool {
  return {
    name: "claude_code_status",
    description:
      "List active Claude Code sessions tracked by the hook plugin. Returns session id, tmux session, state, and log file path.",
    parameters: Type.Object({
      state: Type.Optional(
        Type.String({ description: "Filter by state, e.g. WAITING or ERROR" }),
      ),
    }),
    async execute(params: { state?: string }) {
      let sessions = store.listStates();
      if (params.state) {
        sessions = sessions.filter((s) => s.state === params.state);
      }
      return {
        sessions: sessions.map((s) => ({
          sessionId: s.sessionId,
          tmuxSession: s.tmuxSession,
          state: s.state,
          lastHookEvent: s.lastHookEvent,
          lastSeenAt: s.lastSeenAt,
          logFile: s.logFile,
          workdir: s.workdir,
        })),
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts src/tools.test.ts
git commit -m "feat: claude_code_status agent tool"
```

---

### Task 11: Wire plugin entry point

**Files:**
- Modify: `src/index.ts`
- Modify: `src/index.test.ts`

**Why:** Switch from `defineToolPlugin` to `definePluginEntry` and connect routes, hooks, service, and tools.

- [ ] **Step 1: Update the entry test**

Replace the existing `src/index.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import entry from "./index.js";

describe("claude-code-openclaw-plugin", () => {
  it("exports a defined plugin entry", () => {
    expect(entry.id).toBe("claude-code-openclaw-plugin");
    expect(entry.register).toBeTypeOf("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/index.test.ts`
Expected: FAIL — tests updated, implementation still old.

- [ ] **Step 3: Implement plugin entry**

```ts
import { buildPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";
import { buildClaudeCodeContext } from "./context.js";
import { resolvePluginConfig } from "./config.js";
import { discoverSession } from "./discovery.js";
import { createClaudeCodeRoutes } from "./routes.js";
import { createSessionStore } from "./store.js";
import { sendKeysToTmuxSession, tmuxSessionExists } from "./tmux.js";
import { createClaudeCodeStatusTool } from "./tools.js";

export default definePluginEntry({
  id: "claude-code-openclaw-plugin",
  name: "Claude Code harness",
  description: "Add Claude Code harness tools to OpenClaw.",
  configSchema: buildPluginConfigSchema(
    z.object({
      routePrefix: z.string().default("/claude-code"),
      eventTypes: z.array(z.string()).default(["*"]),
      stateFileDir: z.string().default("~/.cache/claude-code-hooks"),
      notifyStates: z
        .array(z.enum(["WORKING", "WAITING", "QUESTION", "PERMISSION", "ERROR", "DONE", "FATAL"]))
        .default(["WAITING", "QUESTION", "PERMISSION", "ERROR", "DONE"]),
      sendKeysRateLimitPerMinute: z.number().int().positive().default(10),
      sessionTimeoutSeconds: z.number().int().positive().default(300),
    }),
  ),
  register(api: OpenClawPluginApi) {
    const rawConfig = api.pluginConfig ?? {};
    const config = resolvePluginConfig(rawConfig);
    const store = createSessionStore({ stateFileDir: config.stateFileDir });
    const requestHeartbeatNow = () => {
      api.runtime.system.requestHeartbeatNow().catch(() => undefined);
    };

    const routes = createClaudeCodeRoutes({
      store,
      config,
      requestHeartbeatNow,
      discoverSession: async (sessionId) => discoverSession({ sessionId }),
      sendKeys: async ({ tmuxSession, text, submit }) => {
        const exists = await tmuxSessionExists(tmuxSession);
        if (!exists) throw new Error(`tmux session ${tmuxSession} not found`);
        await sendKeysToTmuxSession({ tmuxSession, text, submit });
      },
    });

    api.registerHttpRoute({
      path: `${config.routePrefix}/hook`,
      auth: "plugin",
      match: "exact",
      handler: routes.hook,
    });

    api.registerHttpRoute({
      path: `${config.routePrefix}/`,
      auth: "plugin",
      match: "prefix",
      handler: routes.send,
    });

    api.on("before_prompt_build", async () => {
      const context = buildClaudeCodeContext({
        sessions: store.listStates(),
        notifyStates: config.notifyStates,
      });
      return context ? { prependContext: context } : undefined;
    });

    api.registerTool(createClaudeCodeStatusTool(store));

    let timeoutTimer: ReturnType<typeof setInterval> | undefined;
    api.registerService({
      id: "claude-code-session-timeout",
      start: () => {
        const intervalMs = Math.min(config.sessionTimeoutSeconds * 1000, 60_000);
        timeoutTimer = setInterval(() => {
          const now = Date.now();
          for (const state of store.listStates()) {
            if (now - state.lastSeenAt > config.sessionTimeoutSeconds * 1000) {
              const updated = store.markFatal(state.sessionId, "no hook received within sessionTimeoutSeconds");
              if (updated && config.notifyStates.includes("FATAL")) {
                requestHeartbeatNow();
              }
            }
          }
        }, intervalMs);
        timeoutTimer.unref?.();
      },
      stop: () => {
        if (timeoutTimer) clearInterval(timeoutTimer);
        void store.dispose();
      },
    });
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: wire plugin entry with routes, hooks, service, and tools"
```

---

### Task 12: Add project-level Claude Code hook settings

**Files:**
- Create: `.claude/settings.json`

**Why:** When `claude-task` runs from this repo, Claude Code reads this file and starts POSTing hooks.

- [ ] **Step 1: Create settings file**

```json
{
  "hooks": {
    "*": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:18789/claude-code/hook",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add .claude/settings.json
git commit -m "chore: add project-level Claude Code hook config"
```

---

### Task 13: Build, validate, and run integration checks

**Files:**
- All `src/**/*.ts`

**Why:** Catch type errors and ensure the plugin loads in OpenClaw before claiming done.

- [ ] **Step 1: Type-check and build**

Run: `npm run build`
Expected: `tsc` exits 0, `dist/` populated.

- [ ] **Step 2: Run unit tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Validate plugin entry**

Run: `npm run plugin:validate`
Expected: OpenClaw validates the plugin without errors.

- [ ] **Step 4: Manual end-to-end verification**

1. Ensure OpenClaw is running locally with the plugin enabled in `~/.openclaw/openclaw.json`.
2. From the project root, run:
   ```bash
   claude-task cc-hooks-test "say hello and then stop" 5 "$PWD"
   ```
3. Watch the plugin state directory:
   ```bash
   ls -la ~/.cache/claude-code-hooks/
   ```
4. Expected: a JSON file appears with `sessionId`, `state`, and `lastHookEvent` populated.

- [ ] **Step 5: Commit**

```bash
git add dist .claude/settings.json src
# only if build artifacts are committed; otherwise commit source only
git commit -m "feat: complete Claude Code hook events integration"
```

---

### Task 14: Self-review the plan

Run this checklist mentally and fix any issues inline before execution.

**Spec coverage**

| Spec requirement | Plan task |
|---|---|
| Receive all Claude Code hook events | Task 9 (`/claude-code/hook` route) |
| Correlate via `session_id` | Task 6 (store primary key), Task 4 (tmux discovery) |
| Store origin event + payload | Task 3 (`lastHookEvent`, `lastHookPayload`) |
| State machine | Task 3 (`deriveState`) |
| In-memory cache + disk flush | Task 6 (`createSessionStore`) |
| No separate cron; heartbeat/context-driven | Task 8 (`before_prompt_build`), Task 11 (`requestHeartbeatNow`) |
| `tmux send-keys` control | Task 7, Task 9 (`/send` route) |
| Localhost, no auth | Task 9 (`auth: "plugin"`), Task 12 (`127.0.0.1`) |
| Project-level hook config | Task 12 |
| Tests | Every task has a `*.test.ts` |

**Placeholder scan**

- No `TBD`, `TODO`, or "implement later" remain.
- Every code step includes the actual code.
- Every test step includes expected output.

**Type consistency**

- `ClaudeCodeState` is defined once in `src/config.ts` and reused in `src/state.ts` and `src/context.ts`.
- `SessionState` is defined in `src/state.ts` and consumed by `src/store.ts`, `src/context.ts`, `src/tools.ts`, `src/routes.ts`.
- `SessionStore` return type is exported from `src/store.ts`.
- `PluginConfig` is exported from `src/config.ts`.

---

### Task 15: Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-20-claude-code-hook-events.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach?

---
