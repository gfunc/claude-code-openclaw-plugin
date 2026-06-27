import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createClaudeCodeSetupAgentTool, setupAgent } from "./setup-agent.js";

async function makeTmpConfig(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-agent-"));
  const target = path.join(dir, "openclaw.json");
  await fs.writeFile(target, contents, "utf8");
  return target;
}

describe("setupAgent", () => {
  it("adds cc-watcher when missing", async () => {
    const cfg = await makeTmpConfig(JSON.stringify({ agents: { list: [] } }));
    const res = await setupAgent({ configPath: cfg });
    expect(res.success).toBe(true);
    expect(res.added).toBe(true);
    expect(res.agentId).toBe("cc-watcher");

    const after = JSON.parse(await fs.readFile(cfg, "utf8")) as {
      agents: { list: Array<{ id: string }> };
    };
    expect(after.agents.list).toEqual([{ id: "cc-watcher" }]);
  });

  it("is idempotent — already configured", async () => {
    const cfg = await makeTmpConfig(
      JSON.stringify({ agents: { list: [{ id: "cc-watcher" }] } }),
    );
    const res = await setupAgent({ configPath: cfg });
    expect(res.success).toBe(true);
    expect(res.alreadyConfigured).toBe(true);
    expect(res.added).toBeUndefined();

    const after = JSON.parse(await fs.readFile(cfg, "utf8")) as {
      agents: { list: Array<{ id: string }> };
    };
    expect(after.agents.list).toHaveLength(1);
  });

  it("respects custom agentId", async () => {
    const cfg = await makeTmpConfig(JSON.stringify({ agents: { list: [] } }));
    const res = await setupAgent({ configPath: cfg, agentId: "my-watcher" });
    expect(res.success).toBe(true);
    expect(res.added).toBe(true);
    expect(res.agentId).toBe("my-watcher");

    const after = JSON.parse(await fs.readFile(cfg, "utf8")) as {
      agents: { list: Array<{ id: string }> };
    };
    expect(after.agents.list).toEqual([{ id: "my-watcher" }]);
  });

  it("includes model when provided", async () => {
    const cfg = await makeTmpConfig(JSON.stringify({ agents: { list: [] } }));
    const res = await setupAgent({
      configPath: cfg,
      model: { primary: "anthropic/claude-opus", fallbacks: ["anthropic/claude-sonnet"] },
    });
    expect(res.success).toBe(true);

    const after = JSON.parse(await fs.readFile(cfg, "utf8")) as {
      agents: { list: Array<{ id: string; model?: unknown }> };
    };
    expect(after.agents.list[0]).toEqual({
      id: "cc-watcher",
      model: { primary: "anthropic/claude-opus", fallbacks: ["anthropic/claude-sonnet"] },
    });
  });

  it("omits model when not provided", async () => {
    const cfg = await makeTmpConfig(JSON.stringify({ agents: { list: [] } }));
    await setupAgent({ configPath: cfg });
    const after = JSON.parse(await fs.readFile(cfg, "utf8")) as {
      agents: { list: Array<Record<string, unknown>> };
    };
    expect(after.agents.list[0]).toEqual({ id: "cc-watcher" });
    expect("model" in after.agents.list[0]).toBe(false);
  });

  it("creates agents block if missing", async () => {
    const cfg = await makeTmpConfig(JSON.stringify({}));
    const res = await setupAgent({ configPath: cfg });
    expect(res.success).toBe(true);
    expect(res.added).toBe(true);

    const after = JSON.parse(await fs.readFile(cfg, "utf8")) as {
      agents: { list: Array<{ id: string }> };
    };
    expect(after.agents.list[0].id).toBe("cc-watcher");
  });

  it("fails gracefully on missing config file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-agent-missing-"));
    const target = path.join(dir, "nope.json");
    const res = await setupAgent({ configPath: target });
    expect(res.success).toBe(false);
    expect(res.error ?? "").toContain("cannot read");
  });

  it("fails gracefully on invalid JSON", async () => {
    const cfg = await makeTmpConfig("{not json");
    const res = await setupAgent({ configPath: cfg });
    expect(res.success).toBe(false);
    expect(res.error ?? "").toContain("not valid JSON");
  });

  it("refuses to overwrite non-object agents block", async () => {
    const cfg = await makeTmpConfig(JSON.stringify({ agents: 42 }));
    const res = await setupAgent({ configPath: cfg });
    expect(res.success).toBe(false);
    expect(res.error ?? "").toContain("not an object");
  });
});

describe("claude_code_setup_agent tool", () => {
  it("registers cc-watcher via tool execute", async () => {
    const cfg = await makeTmpConfig(JSON.stringify({ agents: { list: [] } }));
    const tool = createClaudeCodeSetupAgentTool({ configPath: cfg });
    const out = await tool.execute("tc-1", {});
    const details = out.details as { success: boolean; added?: boolean; agentId: string };
    expect(details.success).toBe(true);
    expect(details.added).toBe(true);
    expect(details.agentId).toBe("cc-watcher");
  });
});
