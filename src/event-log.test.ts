import { describe, expect, it } from "vitest";
import { formatHookLogLine } from "./event-log.js";

describe("formatHookLogLine", () => {
  it("renders a transition", () => {
    expect(
      formatHookLogLine({
        ts: Date.UTC(2026, 5, 26, 12, 0, 0),
        event: "Stop",
        prevState: "WORKING",
        newState: "WAITING",
      }),
    ).toBe("2026-06-26T12:00:00.000Z Stop WORKING -> WAITING");
  });

  it("collapses same-state ticks and appends tool", () => {
    expect(
      formatHookLogLine({
        ts: Date.UTC(2026, 5, 26, 12, 0, 1),
        event: "PostToolUse",
        prevState: "WORKING",
        newState: "WORKING",
        tool: "Bash",
      }),
    ).toBe("2026-06-26T12:00:01.000Z PostToolUse WORKING tool=Bash");
  });

  it("omits transition prefix when prev is unknown", () => {
    expect(
      formatHookLogLine({
        ts: Date.UTC(2026, 5, 26, 12, 0, 2),
        event: "SessionStart",
        prevState: undefined,
        newState: "WORKING",
      }),
    ).toBe("2026-06-26T12:00:02.000Z SessionStart WORKING");
  });
});
