import { describe, expect, it } from "vitest";
import entry from "./index.js";

describe("claude-code-openclaw-plugin", () => {
  it("exports a defined plugin entry", () => {
    expect(entry.id).toBe("claude-code-openclaw-plugin");
    expect(entry.register).toBeTypeOf("function");
  });
});
