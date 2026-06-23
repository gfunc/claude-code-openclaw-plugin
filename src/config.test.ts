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
    expect(cfg.targetSessionKey).toBe("agent:main:main");
    expect(cfg.permissionMode).toBe("bypassPermissions");
  });

  it("expands tilde in stateFileDir", () => {
    const cfg = resolvePluginConfig({ stateFileDir: "~/tmp/claude-hooks" });
    expect(cfg.stateFileDir).toBe(
      path.join(os.homedir(), "tmp", "claude-hooks")
    );
  });

  it("rejects invalid notifyStates", () => {
    expect(() => resolvePluginConfig({ notifyStates: ["UNKNOWN"] })).toThrow();
  });

  it("uses provided targetSessionKey", () => {
    const cfg = resolvePluginConfig({ targetSessionKey: "agent:other" });
    expect(cfg.targetSessionKey).toBe("agent:other");
  });

  it("uses provided permissionMode", () => {
    const cfg = resolvePluginConfig({ permissionMode: "default" });
    expect(cfg.permissionMode).toBe("default");
  });
});
