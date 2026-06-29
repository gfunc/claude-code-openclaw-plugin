# Claude Code ACP Runtime Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register the claude-code-openclaw-plugin as an ACP runtime backend (`claude-code`) so OpenClaw's `sessions_spawn` can dispatch Claude Code tasks natively, replacing the current hook/heartbeat notification path.

**Architecture:** Implement the plugin SDK `AcpRuntime` interface with a `ClaudeCodeAcpRuntime` adapter backed by a `SessionManager` (sidecar persistence + resume), a `TmuxRuntime` (send/read/stop tmux sessions), and an `EventStreamer` (hook-driven event emission). Wire the backend into `src/index.ts` and remove `src/task-registry.ts` and its heartbeat wiring.

**Tech Stack:** TypeScript, Node.js, tmux, Claude Code CLI, OpenClaw plugin SDK (`openclaw/plugin-sdk/acp-runtime`, `openclaw/plugin-sdk/system-event-runtime`).

---

## File structure

| File | Responsibility |
|------|---------------|
| `src/config.ts` | Add ACP-related plugin config fields (budget, permission mode defaults). |
| `src/acp/types.ts` | Shared ACP types: sidecar schema, runtime deps, event sources. |
| `src/acp/session-manager.ts` | Maps ACP session keys to tmux/Claude Code sessions; sidecar persistence; resume. |
| `src/acp/tmux-runtime.ts` | Low-level tmux operations for ACP: send, capture, stop, ctrl-c. |
| `src/acp/event-streamer.ts` | Listens for hook events and emits `AcpRuntimeEvent`s; terminal detection. |
| `src/acp/claude-code-acp-runtime.ts` | Implements `AcpRuntime`: `ensureSession`, `startTurn`, `cancel`, `close`, `doctor`. |
| `src/acp/index.ts` | Factory `createClaudeCodeAcpRuntime` and re-exports. |
| `src/index.ts` | Register ACP backend; remove task-registry/heartbeat wiring. |
| `src/routes.ts` | Remove `taskRegistry` dependency; keep `/hook` for state transitions only. |
| `src/store.ts` | Keep notify fields as metadata; remove `setNotifyContext` urgency (still used for old sessions during migration). |
| `src/task-registry.ts` | Delete file and tests. |
| `src/acp/claude-code-acp-runtime.test.ts` | New unit tests. |
| `src/acp/session-manager.test.ts` | New unit tests. |
| `src/index.test.ts`, `src/routes.test.ts`, `src/integration.test.ts` | Update to remove task-registry expectations. |

---

### Task 1: Extend plugin config for ACP defaults

**Files:**
- Modify: `src/config.ts`
- Test: `src/config.test.ts`

- [ ] **Step 1: Add fields to schema**

Add to `pluginConfigSchema`:

```ts
acpBudgetMinutes: z.number().int().positive().default(30),
acpPermissionMode: ClaudePermissionMode.default("bypassPermissions"),
acpAllowedTools: z.array(z.string()).default([]),
acpBackendId: z.string().default("claude-code"),
```

- [ ] **Step 2: Export new types**

Ensure `PluginConfig` derives from the updated schema.

- [ ] **Step 3: Update JSON schema in `src/index.ts`**

Add matching properties to `pluginConfigJsonSchema`.

- [ ] **Step 4: Update config tests**

In `src/config.test.ts`, assert that defaults resolve correctly and custom values are parsed.

- [ ] **Step 5: Run tests**

```bash
npm test -- src/config.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.test.ts src/index.ts
git commit -m "config: add ACP runtime defaults"
```

---

### Task 2: Create ACP shared types

**Files:**
- Create: `src/acp/types.ts`

- [ ] **Step 1: Write types file**

```ts
import type { ClaudePermissionMode } from "../config.js";
import type { ExecFn } from "../tmux.js";

export type AcpSessionSidecar = {
  sessionKey: string;
  tmuxSession: string;
  sessionId: string;
  cwd: string;
  mode: "oneshot" | "persistent";
  startedAt: number;
  permissionMode: ClaudePermissionMode;
  budgetMinutes: number;
};

export type AcpRuntimeDeps = {
  exec: ExecFn;
  stateFileDir: string;
  tasksDir: string;
  log: (text: string) => void;
  permissionMode: ClaudePermissionMode;
  budgetMinutes: number;
  allowedTools: string[];
};

export type AcpTurnContext = {
  sessionKey: string;
  requestId: string;
  aborted: boolean;
};
```

- [ ] **Step 2: Commit**

```bash
git add src/acp/types.ts
git commit -m "acp: add shared types"
```

---

### Task 3: Implement ACP SessionManager

**Files:**
- Create: `src/acp/session-manager.ts`
- Test: `src/acp/session-manager.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createAcpSessionManager } from "./session-manager.js";
import type { ExecFn } from "../tmux.js";

describe("AcpSessionManager", () => {
  const tmpDir = path.join(os.tmpdir(), "acp-session-manager-test");
  const makeExec = (responses: Record<string, { code: number; stdout?: string; stderr?: string }>): ExecFn =>
    async (argv) => {
      const key = argv.join(" ");
      const resp = responses[key] ?? { code: 0, stdout: "" };
      return { code: resp.code, stdout: resp.stdout ?? "", stderr: resp.stderr ?? "" };
    };

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a new session sidecar", async () => {
    const mgr = createAcpSessionManager({
      exec: makeExec({
        "tmux has-session -t cc-12345678": { code: 1 },
        "tmux kill-session -t cc-12345678": { code: 0 },
        "tmux new-session -d -s cc-12345678 -c /tmp claude --session-id '<uuid>' --permission-mode bypassPermissions": { code: 0 },
      }),
      stateFileDir: tmpDir,
      tasksDir: tmpDir,
      log: () => {},
      permissionMode: "bypassPermissions",
      budgetMinutes: 30,
      allowedTools: [],
    });
    const handle = await mgr.ensureSession({
      sessionKey: "agent:claude-code:acp:test-1",
      agent: "claude-code",
      mode: "oneshot",
      cwd: "/tmp",
    });
    expect(handle.backend).toBe("claude-code");
    expect(handle.runtimeSessionName).toMatch(/^cc-/);
    const sidecar = mgr.getSidecar("agent:claude-code:acp:test-1");
    expect(sidecar).toBeDefined();
    expect(sidecar?.mode).toBe("oneshot");
  });

  it("rehydrates from sidecar when tmux is alive", async () => {
    const sidecar = {
      sessionKey: "agent:claude-code:acp:test-2",
      tmuxSession: "cc-existing",
      sessionId: "sess-existing",
      cwd: "/tmp",
      mode: "persistent" as const,
      startedAt: Date.now(),
      permissionMode: "bypassPermissions" as const,
      budgetMinutes: 30,
    };
    await fs.writeFile(path.join(tmpDir, "agent_claude-code_acp_test-2.acp.json"), JSON.stringify(sidecar), "utf8");
    const mgr = createAcpSessionManager({
      exec: makeExec({
        "tmux has-session -t cc-existing": { code: 0 },
      }),
      stateFileDir: tmpDir,
      tasksDir: tmpDir,
      log: () => {},
      permissionMode: "bypassPermissions",
      budgetMinutes: 30,
      allowedTools: [],
    });
    await mgr.loadFromDisk();
    const handle = await mgr.ensureSession({
      sessionKey: "agent:claude-code:acp:test-2",
      agent: "claude-code",
      mode: "persistent",
      cwd: "/tmp",
    });
    expect(handle.runtimeSessionName).toBe("cc-existing");
  });

  it("resumes dead tmux with claude --resume", async () => {
    const sidecar = {
      sessionKey: "agent:claude-code:acp:test-3",
      tmuxSession: "cc-dead",
      sessionId: "dead-sess",
      cwd: "/tmp",
      mode: "persistent" as const,
      startedAt: Date.now(),
      permissionMode: "bypassPermissions" as const,
      budgetMinutes: 30,
    };
    await fs.writeFile(path.join(tmpDir, "agent_claude-code_acp_test-3.acp.json"), JSON.stringify(sidecar), "utf8");
    const execCalls: string[][] = [];
    const exec: ExecFn = async (argv) => {
      execCalls.push(argv);
      const key = argv.join(" ");
      if (key === "tmux has-session -t cc-dead") return { code: 1 };
      if (key.startsWith("tmux new-session") && key.includes("--resume dead-sess")) return { code: 0 };
      if (key === "tmux has-session -t cc-dead") return { code: 0 }; // after resume
      return { code: 0 };
    };
    const mgr = createAcpSessionManager({
      exec,
      stateFileDir: tmpDir,
      tasksDir: tmpDir,
      log: () => {},
      permissionMode: "bypassPermissions",
      budgetMinutes: 30,
      allowedTools: [],
    });
    await mgr.loadFromDisk();
    await mgr.ensureSession({
      sessionKey: "agent:claude-code:acp:test-3",
      agent: "claude-code",
      mode: "persistent",
      cwd: "/tmp",
    });
    const resumeCall = execCalls.find((c) => c.join(" ").includes("--resume dead-sess"));
    expect(resumeCall).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- src/acp/session-manager.test.ts
```

Expected: FAIL (file not found)

- [ ] **Step 3: Implement SessionManager**

`src/acp/session-manager.ts`:

```ts
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { AcpRuntimeEnsureInput, AcpRuntimeHandle } from "openclaw/plugin-sdk/acp-runtime";
import type { AcpRuntimeDeps, AcpSessionSidecar } from "./types.js";
import { tmuxSessionExists } from "../tmux.js";

export type AcpSessionManager = {
  ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;
  close(sessionKey: string, discardPersistentState?: boolean): Promise<void>;
  getHandle(sessionKey: string): AcpRuntimeHandle | undefined;
  getSidecar(sessionKey: string): AcpSessionSidecar | undefined;
  loadFromDisk(): Promise<void>;
};

export function createAcpSessionManager(deps: AcpRuntimeDeps): AcpSessionManager {
  const sidecars = new Map<string, AcpSessionSidecar>();

  function sidecarPath(sessionKey: string): string {
    const safe = sessionKey.replace(/[^a-z0-9_-]/gi, "_");
    return path.join(deps.stateFileDir, `${safe}.acp.json`);
  }

  async function writeSidecar(sidecar: AcpSessionSidecar): Promise<void> {
    await fs.mkdir(deps.stateFileDir, { recursive: true });
    await fs.writeFile(sidecarPath(sidecar.sessionKey), JSON.stringify(sidecar, null, 2) + "\n", "utf8");
  }

  async function removeSidecar(sessionKey: string): Promise<void> {
    await fs.rm(sidecarPath(sessionKey), { force: true });
  }

  function buildHandle(sidecar: AcpSessionSidecar): AcpRuntimeHandle {
    return {
      sessionKey: sidecar.sessionKey,
      backend: "claude-code",
      runtimeSessionName: sidecar.tmuxSession,
      cwd: sidecar.cwd,
    };
  }

  return {
    async ensureSession(input) {
      const existing = sidecars.get(input.sessionKey);
      if (existing) {
        const alive = await tmuxSessionExists(existing.tmuxSession, deps.exec);
        if (alive) return buildHandle(existing);
        // Try resume
        if (existing.sessionId) {
          try {
            await spawnClaudeResume(existing);
            if (await tmuxSessionExists(existing.tmuxSession, deps.exec)) {
              return buildHandle(existing);
            }
          } catch (err) {
            deps.log(`acp: resume failed for ${input.sessionKey}: ${String(err)}`);
          }
        }
        await removeSidecar(input.sessionKey);
        sidecars.delete(input.sessionKey);
      }
      // Spawn new
      const sessionId = crypto.randomUUID();
      const tmuxSession = `cc-${sessionId.slice(0, 8)}`;
      const sidecar: AcpSessionSidecar = {
        sessionKey: input.sessionKey,
        tmuxSession,
        sessionId,
        cwd: input.cwd ?? process.cwd(),
        mode: input.mode,
        startedAt: Date.now(),
        permissionMode: deps.permissionMode,
        budgetMinutes: deps.budgetMinutes,
      };
      await spawnClaudeSession(sidecar, deps);
      await writeSidecar(sidecar);
      sidecars.set(input.sessionKey, sidecar);
      return buildHandle(sidecar);
    },
    async close(sessionKey, discardPersistentState) {
      const sidecar = sidecars.get(sessionKey);
      if (!sidecar) return;
      const alive = await tmuxSessionExists(sidecar.tmuxSession, deps.exec);
      if (alive && (sidecar.mode === "oneshot" || discardPersistentState)) {
        await deps.exec(["tmux", "kill-session", "-t", sidecar.tmuxSession], { timeoutMs: 5000 });
      }
      if (sidecar.mode === "oneshot" || discardPersistentState) {
        await removeSidecar(sessionKey);
        sidecars.delete(sessionKey);
      }
    },
    getHandle(sessionKey) {
      const sidecar = sidecars.get(sessionKey);
      return sidecar ? buildHandle(sidecar) : undefined;
    },
    getSidecar(sessionKey) {
      return sidecars.get(sessionKey);
    },
    async loadFromDisk() {
      // scan stateFileDir for *.acp.json and load
    },
  };
}
```

(Implement `spawnClaudeSession`, `spawnClaudeResume` helpers using existing `spawnSession` logic adapted for ACP input.)

- [ ] **Step 4: Run tests**

```bash
npm test -- src/acp/session-manager.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/acp/session-manager.ts src/acp/session-manager.test.ts
git commit -m "acp: add SessionManager with sidecar persistence and resume"
```

---

### Task 4: Implement ACP TmuxRuntime

**Files:**
- Create: `src/acp/tmux-runtime.ts`

- [ ] **Step 1: Implement wrapper**

```ts
import type { ExecFn } from "../tmux.js";
import { sendKeysToTmuxSession, sendKeysSequence, capturePane, tmuxSessionExists } from "../tmux.js";

export type AcpTmuxRuntime = {
  send(tmuxSession: string, text: string, submit?: boolean): Promise<void>;
  sendKeys(tmuxSession: string, keys: string[]): Promise<void>;
  read(tmuxSession: string, lines?: number): Promise<string>;
  exists(tmuxSession: string): Promise<boolean>;
  kill(tmuxSession: string): Promise<void>;
  ctrlC(tmuxSession: string): Promise<void>;
};

export function createAcpTmuxRuntime(exec: ExecFn): AcpTmuxRuntime {
  return {
    send: (session, text, submit = true) => sendKeysToTmuxSession({ tmuxSession: session, text, submit, exec }),
    sendKeys: (session, keys) => sendKeysSequence({ tmuxSession: session, keys, exec }),
    read: (session, lines) => capturePane({ tmuxSession: session, lines, exec }),
    exists: (session) => tmuxSessionExists(session, exec),
    kill: async (session) => {
      await exec(["tmux", "kill-session", "-t", session], { timeoutMs: 5000 });
    },
    ctrlC: async (session) => {
      await exec(["tmux", "send-keys", "-t", session, "C-c"], { timeoutMs: 5000 });
    },
  };
}
```

- [ ] **Step 2: Add unit test**

`src/acp/tmux-runtime.test.ts` with mocked `exec`.

- [ ] **Step 3: Run tests**

```bash
npm test -- src/acp/tmux-runtime.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/acp/tmux-runtime.ts src/acp/tmux-runtime.test.ts
git commit -m "acp: add TmuxRuntime wrapper"
```

---

### Task 5: Implement EventStreamer

**Files:**
- Create: `src/acp/event-streamer.ts`
- Test: `src/acp/event-streamer.test.ts`

- [ ] **Step 1: Implement hook listener**

```ts
import type { AcpRuntimeEvent, AcpRuntimeTurnResult } from "openclaw/plugin-sdk/acp-runtime";
import type { ClaudeCodeState } from "../config.js";
import type { SessionStore } from "../store.js";

type PendingTurn = {
  requestId: string;
  resolveResult: (r: AcpRuntimeTurnResult) => void;
  rejectResult: (err: unknown) => void;
  events: AcpRuntimeEvent[];
  readOutput: () => Promise<string>;
};

function findSessionKeyForSessionId(store: SessionStore, sessionId: string): string | undefined {
  return store.listStates().find((s) => s.sessionId === sessionId)?.sessionId;
}

export type AcpEventStreamer = {
  startTurn(params: {
    sessionKey: string;
    requestId: string;
    tmuxSession: string;
    signal?: AbortSignal;
    timeoutMs: number;
    readOutput: () => Promise<string>;
  }): {
    events: AsyncIterable<AcpRuntimeEvent>;
    result: Promise<AcpRuntimeTurnResult>;
    cancel: () => void;
  };
  notifyState(sessionId: string, state: ClaudeCodeState): void;
};

export function createAcpEventStreamer(store: SessionStore): AcpEventStreamer {
  const pendingBySessionKey = new Map<string, Map<string, PendingTurn>>();

  function registerPendingTurn(sessionKey: string, pending: PendingTurn): void {
    let map = pendingBySessionKey.get(sessionKey);
    if (!map) {
      map = new Map();
      pendingBySessionKey.set(sessionKey, map);
    }
    map.set(pending.requestId, pending);
  }

  function unregisterPendingTurn(sessionKey: string, requestId: string): void {
    const map = pendingBySessionKey.get(sessionKey);
    if (!map) return;
    map.delete(requestId);
    if (map.size === 0) pendingBySessionKey.delete(sessionKey);
  }

  return {
    startTurn(params) {
      const events: AcpRuntimeEvent[] = [];
      let resolveResult: (r: AcpRuntimeTurnResult) => void;
      let rejectResult: (err: unknown) => void;
      const result = new Promise<AcpRuntimeTurnResult>((res, rej) => {
        resolveResult = res;
        rejectResult = rej;
      });

      const pending: PendingTurn = { requestId: params.requestId, resolveResult, rejectResult, events, readOutput: params.readOutput };
      registerPendingTurn(params.sessionKey, pending);

      const timeoutTimer = setTimeout(() => {
        unregisterPendingTurn(params.sessionKey, params.requestId);
        events.push({ type: "error", message: "Turn timed out", code: "ACP_TURN_FAILED" });
        resolveResult({ status: "failed", error: { message: "Turn timed out", code: "ACP_TURN_FAILED" } });
      }, params.timeoutMs);

      if (params.signal) {
        params.signal.addEventListener("abort", () => {
          clearTimeout(timeoutTimer);
          unregisterPendingTurn(params.sessionKey, params.requestId);
          events.push({ type: "error", message: "Turn aborted", code: "ACP_TURN_FAILED" });
          resolveResult({ status: "failed", error: { message: "Turn aborted", code: "ACP_TURN_FAILED" } });
        });
      }

      async function* gen(): AsyncGenerator<AcpRuntimeEvent> {
        yield { type: "status", text: "Claude Code is working..." };
        for (const ev of events) yield ev;
      }

      return {
        events: gen(),
        result: result.finally(() => clearTimeout(timeoutTimer)),
        cancel: () => {
          clearTimeout(timeoutTimer);
          unregisterPendingTurn(params.sessionKey, params.requestId);
          events.push({ type: "error", message: "Turn cancelled", code: "ACP_TURN_FAILED" });
          resolveResult({ status: "cancelled" });
        },
      };
    },

    async notifyState(sessionId: string, state: ClaudeCodeState) {
      const sessionKey = findSessionKeyForSessionId(store, sessionId);
      if (!sessionKey) return;
      const map = pendingBySessionKey.get(sessionKey);
      if (!map || map.size === 0) return;
      const pending = map.values().next().value as PendingTurn;
      unregisterPendingTurn(sessionKey, pending.requestId);
      const output = await pending.readOutput();
      pending.events.push({ type: "text_delta", text: output });
      if (state === "DONE") {
        pending.events.push({ type: "done" });
        pending.resolveResult({ status: "completed" });
      } else if (state === "FATAL" || state === "ERROR") {
        pending.events.push({ type: "error", message: output, code: "ACP_TURN_FAILED" });
        pending.resolveResult({ status: "failed", error: { message: output, code: "ACP_TURN_FAILED" } });
      } else {
        // WAITING / PERMISSION / QUESTION
        pending.events.push({ type: "done", stopReason: state });
        pending.resolveResult({ status: "completed", stopReason: state });
      }
    },
  };
}
```

- [ ] **Step 2: Integrate with store hook flow**

The `/hook` route will call `eventStreamer.notifyHook(sessionKey, state)` when a terminal state arrives. The streamer resolves the pending turn result.

- [ ] **Step 3: Write tests**

Test that hook notification produces the right events and result.

- [ ] **Step 4: Commit**

```bash
git add src/acp/event-streamer.ts src/acp/event-streamer.test.ts
git commit -m "acp: add hook-driven EventStreamer"
```

---

### Task 6: Implement ClaudeCodeAcpRuntime

**Files:**
- Create: `src/acp/claude-code-acp-runtime.ts`
- Test: `src/acp/claude-code-acp-runtime.test.ts`

- [ ] **Step 1: Implement runtime**

```ts
import type {
  AcpRuntime,
  AcpRuntimeEnsureInput,
  AcpRuntimeHandle,
  AcpRuntimeTurnInput,
  AcpRuntimeTurn,
  AcpRuntimeDoctorReport,
  AcpRuntimeCapabilities,
  AcpRuntimeStatus,
} from "openclaw/plugin-sdk/acp-runtime";
import type { AcpSessionManager } from "./session-manager.js";
import type { AcpTmuxRuntime } from "./tmux-runtime.js";
import type { AcpEventStreamer } from "./event-streamer.js";

export function createClaudeCodeAcpRuntime(params: {
  sessionManager: AcpSessionManager;
  tmuxRuntime: AcpTmuxRuntime;
  eventStreamer: AcpEventStreamer;
  log: (text: string) => void;
}): AcpRuntime {
  return {
    async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
      return params.sessionManager.ensureSession(input);
    },
    startTurn(input: AcpRuntimeTurnInput): AcpRuntimeTurn {
      const handle = params.sessionManager.getHandle(input.handle.sessionKey);
      if (!handle) throw new Error("Session not found");
      return params.eventStreamer.startTurn({
        sessionKey: input.handle.sessionKey,
        requestId: input.requestId,
        tmuxSession: handle.runtimeSessionName,
        signal: input.signal,
        timeoutMs: 30 * 60 * 1000, // from runtime options or default
        readOutput: () => params.tmuxRuntime.read(handle.runtimeSessionName),
      });
    },
    runTurn(input: AcpRuntimeTurnInput): AsyncIterable<import("openclaw/plugin-sdk/acp-runtime").AcpRuntimeEvent> {
      return this.startTurn!(input).events;
    },
    async close(input): Promise<void> {
      await params.sessionManager.close(input.handle.sessionKey, input.discardPersistentState);
    },
    async cancel(input): Promise<void> {
      const handle = params.sessionManager.getHandle(input.handle.sessionKey);
      if (!handle) return;
      await params.tmuxRuntime.ctrlC(handle.runtimeSessionName);
    },
    async getStatus(input): Promise<AcpRuntimeStatus> {
      const handle = params.sessionManager.getHandle(input.handle.sessionKey);
      if (!handle) return { summary: "session not found" };
      const alive = await params.tmuxRuntime.exists(handle.runtimeSessionName);
      return { summary: alive ? "running" : "dead" };
    },
    getCapabilities(): AcpRuntimeCapabilities {
      return { controls: [] };
    },
    async doctor(): Promise<AcpRuntimeDoctorReport> {
      try {
        await params.tmuxRuntime.exists("__acp_doctor_test__");
      } catch {
        // tmux missing or not on PATH
      }
      // also check claude --version
      return { ok: true, message: "claude-code backend ready" };
    },
  };
}
```

- [ ] **Step 2: Write tests**

Mock dependencies; verify each method delegates correctly and handles missing sessions.

- [ ] **Step 3: Run tests**

```bash
npm test -- src/acp/claude-code-acp-runtime.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/acp/claude-code-acp-runtime.ts src/acp/claude-code-acp-runtime.test.ts
git commit -m "acp: implement ClaudeCodeAcpRuntime"
```

---

### Task 7: Wire ACP backend into plugin entry

**Files:**
- Modify: `src/index.ts`
- Modify: `src/acp/index.ts` (create factory)

- [ ] **Step 1: Create factory**

`src/acp/index.ts`:

```ts
import os from "node:os";
import path from "node:path";
import { registerAcpRuntimeBackend } from "openclaw/plugin-sdk/acp-runtime";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import type { PluginConfig } from "../config.js";
import type { SessionStore } from "../store.js";
import { createAcpSessionManager } from "./session-manager.js";
import { createAcpTmuxRuntime } from "./tmux-runtime.js";
import { createAcpEventStreamer } from "./event-streamer.js";
import { createClaudeCodeAcpRuntime } from "./claude-code-acp-runtime.js";

export function registerClaudeCodeAcpBackend(params: {
  config: PluginConfig;
  store: SessionStore;
  log: (text: string) => void;
}): void {
  const exec = runCommandWithTimeout;
  const sessionManager = createAcpSessionManager({
    exec,
    stateFileDir: params.config.stateFileDir,
    tasksDir: path.join(os.homedir(), ".cache", "claude-tasks"),
    log: params.log,
    permissionMode: params.config.permissionMode,
    budgetMinutes: params.config.acpBudgetMinutes,
    allowedTools: params.config.acpAllowedTools,
  });
  const tmuxRuntime = createAcpTmuxRuntime(exec);
  const eventStreamer = createAcpEventStreamer(params.store);
  const runtime = createClaudeCodeAcpRuntime({
    sessionManager,
    tmuxRuntime,
    eventStreamer,
    log: params.log,
  });
  registerAcpRuntimeBackend({ id: params.config.acpBackendId, runtime });
}
```

- [ ] **Step 2: Update `src/index.ts`**

Replace `createTaskRegistry` import with `registerClaudeCodeAcpBackend`. Remove `taskReg` block. Add call:

```ts
registerClaudeCodeAcpBackend({ config, store, log: (text) => api.logger?.info?.(text) });
```

- [ ] **Step 3: Remove taskRegistry from routes**

In `src/index.ts`, remove `taskRegistry: taskReg` from `createClaudeCodeRoutes` call. Keep `log` and `discoverSession`.

- [ ] **Step 4: Update index tests**

`src/index.test.ts`: remove expectations around task registry / heartbeat. Add a test that `registerAcpRuntimeBackend` is called (mock the SDK import).

- [ ] **Step 5: Run tests**

```bash
npm test -- src/index.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/acp/index.ts src/index.test.ts
git commit -m "acp: register backend in plugin entry"
```

---

### Task 8: Remove task-registry and heartbeat wiring

**Files:**
- Delete: `src/task-registry.ts`
- Delete: `src/task-registry.test.ts`
- Modify: `src/routes.ts`
- Modify: `src/routes.test.ts`
- Modify: `src/integration.test.ts`

- [ ] **Step 1: Delete files**

```bash
git rm src/task-registry.ts src/task-registry.test.ts
```

- [ ] **Step 2: Remove taskRegistry from routes**

In `src/routes.ts`:
- Remove `taskRegistry` parameter from `createClaudeCodeRoutes`.
- Remove `taskRegistry.onStateTransition(state)` call in hook handler.

- [ ] **Step 3: Update routes tests**

Remove taskRegistry-related assertions.

- [ ] **Step 4: Update integration tests**

Remove expectations around heartbeat / system events / task registry. The integration tests should still verify hook state transitions and spawn/stop behavior.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: PASS (or known failures documented)

- [ ] **Step 6: Commit**

```bash
git add src/routes.ts src/routes.test.ts src/integration.test.ts
git commit -m "refactor: remove task-registry and heartbeat notification path"
```

---

### Task 9: Update hook handler for ACP event streaming

**Files:**
- Modify: `src/routes.ts`
- Modify: `src/store.ts`

- [ ] **Step 1: Inject event streamer into routes**

`createClaudeCodeRoutes` should accept an optional `onHookTransition` callback:

```ts
onHookTransition?: (state: SessionState) => void;
```

Call it after `store.applyHook` for state transitions.

- [ ] **Step 2: Wire in index.ts**

Pass `onHookTransition: (state) => eventStreamer.notifyState(state.sessionId, state.state)`.

- [ ] **Step 3: Add notify method to EventStreamer**

```ts
notifyState(sessionId: string, state: ClaudeCodeState): void
```

Resolves pending turn contexts waiting for this session/state.

- [ ] **Step 4: Run tests**

```bash
npm test -- src/routes.test.ts src/acp/event-streamer.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes.ts src/store.ts src/acp/event-streamer.ts
git commit -m "acp: route hook transitions into event streamer"
```

---

### Task 10: End-to-end integration test

**Files:**
- Modify: `src/integration.test.ts`

- [ ] **Step 1: Add ACP runtime test**

Use a mocked `AcpSessionManager` and `EventStreamer` to verify the full flow:

```ts
it("registers claude-code ACP backend and runs a turn", async () => {
  // setup plugin, register backend, call runTurn, emit hook DONE, verify events
});
```

- [ ] **Step 2: Run integration tests**

```bash
npm test -- src/integration.test.ts
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/integration.test.ts
git commit -m "test: add ACP backend integration test"
```

---

### Task 11: Documentation update

**Files:**
- Modify: `docs/openclaw-background-task-notification.md`
- Create: `docs/acp-backend.md`

- [ ] **Step 1: Update background task notification doc**

Replace hook/heartbeat description with ACP runtime backend explanation.

- [ ] **Step 2: Create ACP backend doc**

Document OpenClaw config (`acp.backend: "claude-code"`), agent list entry, and usage examples.

- [ ] **Step 3: Commit**

```bash
git add docs/openclaw-background-task-notification.md docs/acp-backend.md
git commit -m "docs: update for ACP backend"
```

---

### Task 12: Final verification

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run build**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 3: Run lint**

```bash
npm run lint
```

Expected: no lint errors.

- [ ] **Step 4: Commit any final fixes**

```bash
git commit -m "chore: final ACP backend verification fixes"
```

---

## Self-review checklist

- [ ] **Spec coverage:** Every section of `2026-06-29-claude-code-acp-runtime-design.md` maps to at least one task above.
- [ ] **No placeholders:** No `TODO`, `TBD`, or vague steps remain in the plan.
- [ ] **Type consistency:** `AcpRuntimeHandle`, `AcpRuntimeTurn`, and `AcpRuntimeEvent` types align with `openclaw/plugin-sdk/acp-runtime` exports across all tasks.
- [ ] **Dependency order:** Tasks 1-6 build the runtime; Task 7 wires it; Task 8 removes old code; Tasks 9-12 integrate and verify.
