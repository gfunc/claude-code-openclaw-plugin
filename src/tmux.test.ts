import { describe, expect, it, vi } from "vitest";
import { sendKeysToTmuxSession, tmuxSessionExists } from "./tmux.js";

describe("sendKeysToTmuxSession", () => {
  it("runs tmux send-keys with literal text", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await sendKeysToTmuxSession({ tmuxSession: "cc-test", text: "hello", submit: false, exec });
    expect(exec).toHaveBeenCalledWith(
      ["tmux", "send-keys", "-t", "cc-test", "-l", "hello"],
      { timeoutMs: 5000 },
    );
  });

  it("appends Enter when submit is true", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await sendKeysToTmuxSession({ tmuxSession: "cc-test", text: "yes", submit: true, exec });
    expect(exec).toHaveBeenCalledWith(
      ["tmux", "send-keys", "-t", "cc-test", "-l", "yes", "Enter"],
      { timeoutMs: 5000 },
    );
  });

  it("rejects tmux control characters in literal mode input", async () => {
    const exec = vi.fn();
    await expect(
      sendKeysToTmuxSession({ tmuxSession: "cc-test", text: "foo\x1bbar", submit: false, exec }),
    ).rejects.toThrow();
  });

  it("throws when tmux returns non-zero", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "no session", code: 1 });
    await expect(
      sendKeysToTmuxSession({ tmuxSession: "missing", text: "hi", submit: false, exec }),
    ).rejects.toThrow("no session");
  });
});

describe("tmuxSessionExists", () => {
  it("returns true when tmux has-session succeeds", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const exists = await tmuxSessionExists("cc-test", exec);
    expect(exists).toBe(true);
    expect(exec).toHaveBeenCalledWith(["tmux", "has-session", "-t", "cc-test"], { timeoutMs: 2000 });
  });

  it("returns false when tmux has-session fails", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 1 });
    const exists = await tmuxSessionExists("missing", exec);
    expect(exists).toBe(false);
  });
});
