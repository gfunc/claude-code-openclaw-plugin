import { describe, expect, it } from "vitest";
import { createClaudeCodeSetupHooksTool, handleSetupHooksRoute } from "./setup-hooks.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("claude_code_setup_hooks tool", () => {
  it("writes settings.local.json from template", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "setup-hooks-"));
    const templateDir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-hooks-template-"));
    const template = path.join(templateDir, "settings.json");
    await fs.writeFile(template, JSON.stringify({ hooks: { url: "http://127.0.0.1:18789/claude-code/hook" } }), "utf8");

    const tool = createClaudeCodeSetupHooksTool({ templatePath: template });
    const result = await tool.execute("tc-1", { repoPath: repo });
    const details = result.details as { success: boolean; target: string };

    expect(details.success).toBe(true);
    expect(details.target).toBe(path.join(repo, ".claude", "settings.local.json"));
    const written = await fs.readFile(details.target, "utf8");
    expect(written).toContain("http://127.0.0.1:18789/claude-code/hook");
  });
});
