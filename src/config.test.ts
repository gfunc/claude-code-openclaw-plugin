import { describe, expect, it } from "vitest";
import { resolvePluginConfig } from "./config.js";

describe("resolvePluginConfig targetSessionKey", () => {
  it("defaults to agent:main:main", () => {
    const config = resolvePluginConfig({});
    expect(config.targetSessionKey).toBe("agent:main:main");
  });

  it("uses provided value", () => {
    const config = resolvePluginConfig({ targetSessionKey: "agent:other" });
    expect(config.targetSessionKey).toBe("agent:other");
  });
});
