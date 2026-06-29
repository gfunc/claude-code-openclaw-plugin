import { describe, it, expect } from "vitest";
import { createAcpTmuxRuntime } from "./tmux-runtime.js";
import type { ExecFn } from "../tmux.js";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";

function spawnResult(overrides?: Partial<SpawnResult>): SpawnResult {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

describe("AcpTmuxRuntime", () => {
  const makeExec = (responses: Record<string, Partial<SpawnResult>>): ExecFn =>
    async (argv) => {
      const key = argv.join(" ");
      const resp = responses[key] ?? {};
      return spawnResult(resp);
    };

  it("sends text via send", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (argv) => {
      calls.push(argv);
      return spawnResult();
    };
    const runtime = createAcpTmuxRuntime(exec);
    await runtime.send("cc-test", "hello world");
    expect(calls).toContainEqual(["tmux", "send-keys", "-t", "cc-test", "-l", "hello world"]);
    expect(calls).toContainEqual(["tmux", "send-keys", "-t", "cc-test", "Enter"]);
  });

  it("sends key sequences", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (argv) => {
      calls.push(argv);
      return spawnResult();
    };
    const runtime = createAcpTmuxRuntime(exec);
    await runtime.sendKeys("cc-test", ["Enter", "Escape"]);
    expect(calls).toContainEqual(["tmux", "send-keys", "-t", "cc-test", "Enter", "Escape"]);
  });

  it("reads pane output", async () => {
    const exec = makeExec({
      "tmux capture-pane -t cc-test -p -S -50": { code: 0, stdout: "output" },
    });
    const runtime = createAcpTmuxRuntime(exec);
    const text = await runtime.read("cc-test", 50);
    expect(text).toBe("output");
  });

  it("checks session existence", async () => {
    const exec = makeExec({ "tmux has-session -t cc-test": { code: 0 } });
    const runtime = createAcpTmuxRuntime(exec);
    await expect(runtime.exists("cc-test")).resolves.toBe(true);
  });

  it("kills a session", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (argv) => {
      calls.push(argv);
      return spawnResult();
    };
    const runtime = createAcpTmuxRuntime(exec);
    await runtime.kill("cc-test");
    expect(calls).toContainEqual(["tmux", "kill-session", "-t", "cc-test"]);
  });

  it("sends Ctrl+C", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (argv) => {
      calls.push(argv);
      return spawnResult();
    };
    const runtime = createAcpTmuxRuntime(exec);
    await runtime.ctrlC("cc-test");
    expect(calls).toContainEqual(["tmux", "send-keys", "-t", "cc-test", "C-c"]);
  });
});
