import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { resolvePluginConfig } from "./config.js";

describe("resolvePluginConfig", () => {
  it("applies defaults", () => {
    const cfg = resolvePluginConfig({});
    expect(cfg.routePrefix).toBe("/claude-code");
    expect(cfg.stateFileDir).toBe(
      path.join(os.homedir(), ".cache", "claude-code-hooks")
    );
    expect(cfg.defaultNotifySessionKey).toBe("agent:cc-watcher:main");
    expect(cfg.permissionMode).toBe("bypassPermissions");
  });

  it("expands tilde in stateFileDir", () => {
    const cfg = resolvePluginConfig({ stateFileDir: "~/tmp/claude-hooks" });
    expect(cfg.stateFileDir).toBe(
      path.join(os.homedir(), "tmp", "claude-hooks")
    );
  });

  it("uses provided defaultNotifySessionKey", () => {
    const cfg = resolvePluginConfig({ defaultNotifySessionKey: "agent:other" });
    expect(cfg.defaultNotifySessionKey).toBe("agent:other");
  });

  it("strips unknown config field wecomWebhookUrl", () => {
    const cfg = resolvePluginConfig({ wecomWebhookUrl: "https://example.com" });
    expect((cfg as Record<string, unknown>).wecomWebhookUrl).toBeUndefined();
  });

  it("strips unknown config field notifyStates", () => {
    const cfg = resolvePluginConfig({ notifyStates: ["WAITING"] });
    expect((cfg as Record<string, unknown>).notifyStates).toBeUndefined();
  });

  it("uses provided permissionMode", () => {
    const cfg = resolvePluginConfig({ permissionMode: "default" });
    expect(cfg.permissionMode).toBe("default");
  });

  it("accepts every Claude Code permission mode", () => {
    for (const mode of ["default", "acceptEdits", "plan", "bypassPermissions"] as const) {
      expect(resolvePluginConfig({ permissionMode: mode }).permissionMode).toBe(mode);
    }
  });

  it("rejects an unknown permissionMode", () => {
    expect(() => resolvePluginConfig({ permissionMode: "yolo" })).toThrow();
  });
});
