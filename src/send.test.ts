import { describe, expect, it, vi } from "vitest";
import { createClaudeCodeSendTool, handleSendRoute, sendToSession } from "./send.js";
import * as tmux from "./tmux.js";

describe("claude_code_send", () => {
  it("types text and submits by default", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    vi.spyOn(tmux, "tmuxSessionExists").mockResolvedValue(true);
    const spy = vi.spyOn(tmux, "sendKeysToTmuxSession").mockResolvedValue();

    const result = await sendToSession({ tmuxSession: "cc-test", text: "yes" });

    expect(result).toEqual({
      success: true,
      tmuxSession: "cc-test",
      submitted: true,
      keysSent: 0,
    });
    expect(spy).toHaveBeenCalledWith({ tmuxSession: "cc-test", text: "yes", submit: true });
    exec.mockClear();
    vi.restoreAllMocks();
  });

  it("sends a key sequence for menu navigation", async () => {
    vi.spyOn(tmux, "tmuxSessionExists").mockResolvedValue(true);
    const textSpy = vi.spyOn(tmux, "sendKeysToTmuxSession").mockResolvedValue();
    const keySpy = vi.spyOn(tmux, "sendKeysSequence").mockResolvedValue();

    const result = await sendToSession({ tmuxSession: "cc-test", keys: ["Down", "Enter"] });

    expect(result).toEqual({
      success: true,
      tmuxSession: "cc-test",
      submitted: undefined,
      keysSent: 2,
    });
    expect(keySpy).toHaveBeenCalledWith({ tmuxSession: "cc-test", keys: ["Down", "Enter"] });
    expect(textSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("requires text or keys", async () => {
    vi.spyOn(tmux, "tmuxSessionExists").mockResolvedValue(true);
    const result = await sendToSession({ tmuxSession: "cc-test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("text or keys");
    vi.restoreAllMocks();
  });

  it("returns failure when the session does not exist", async () => {
    vi.spyOn(tmux, "tmuxSessionExists").mockResolvedValue(false);
    const result = await sendToSession({ tmuxSession: "missing", text: "hi" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    vi.restoreAllMocks();
  });

  it("exposes a claude_code_send tool", () => {
    const tool = createClaudeCodeSendTool();
    expect(tool.name).toBe("claude_code_send");
  });

  it("validates required fields in the HTTP route", async () => {
    const res = await handleSendRoute({ tmuxSession: "cc-test" });
    expect(res.status).toBe(404);
  });
});
