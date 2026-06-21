import { describe, expect, it } from "vitest";
import { resolveBehavior, STATE_BEHAVIOR } from "./behavior.js";

describe("STATE_BEHAVIOR", () => {
  it("WAITING announces with warning prefix", () => {
    const b = STATE_BEHAVIOR.WAITING;
    expect(b.announce).toBe(true);
    expect(b.prompt).toBe(true);
    expect(b.prefix).toBe("⚠️");
    expect(b.message).toContain("waiting");
  });

  it("WORKING does nothing", () => {
    const b = STATE_BEHAVIOR.WORKING;
    expect(b.announce).toBe(false);
    expect(b.prompt).toBe(false);
  });

  it("FATAL is one-shot announce", () => {
    const b = STATE_BEHAVIOR.FATAL;
    expect(b.announce).toBe(true);
    expect(b.oneShotAnnounce).toBe(true);
  });
});

describe("resolveBehavior", () => {
  it("returns table defaults when state is in notifyStates", () => {
    const b = resolveBehavior("WAITING", ["WAITING", "ERROR"]);
    expect(b.announce).toBe(true);
  });

  it("disables announce when state is not in notifyStates", () => {
    const b = resolveBehavior("DONE", ["WAITING"]);
    expect(b.announce).toBe(false);
  });
});
