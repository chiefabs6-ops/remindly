import { describe, expect, it } from "vitest";
import { nextRepeatDue, repeatLabel } from "./dates";

describe("nextRepeatDue", () => {
  it("adds days", () => {
    expect(nextRepeatDue("2026-11-24", 1, "day")).toBe("2026-11-25");
    expect(nextRepeatDue("2026-11-30", 2, "day")).toBe("2026-12-02");
  });
  it("adds weeks", () => {
    expect(nextRepeatDue("2026-11-24", 1, "week")).toBe("2026-12-01");
    expect(nextRepeatDue("2026-11-24", 2, "week")).toBe("2026-12-08");
  });
  it("adds months and clamps to the end of a short month", () => {
    expect(nextRepeatDue("2026-01-15", 1, "month")).toBe("2026-02-15");
    expect(nextRepeatDue("2026-01-31", 1, "month")).toBe("2026-02-28");
    expect(nextRepeatDue("2026-11-30", 3, "month")).toBe("2027-02-28");
  });
  it("counts working days only", () => {
    // Friday 27 Nov 2026.
    expect(nextRepeatDue("2026-11-27", 1, "weekday")).toBe("2026-11-30");
    expect(nextRepeatDue("2026-11-27", 3, "weekday")).toBe("2026-12-02");
    expect(nextRepeatDue("2026-11-24", 1, "weekday")).toBe("2026-11-25");
  });
});

describe("repeatLabel", () => {
  it("reads naturally", () => {
    expect(repeatLabel(1, "day")).toBe("every day");
    expect(repeatLabel(1, "weekday")).toBe("every working day");
    expect(repeatLabel(2, "week")).toBe("every 2 weeks");
    expect(repeatLabel(3, "weekday")).toBe("every 3 working days");
    expect(repeatLabel(1, "month")).toBe("every month");
  });
});
