import { describe, expect, it } from "vitest";
import { addDays, dayDiff, findDate, relativeDayLabel } from "./dates";
import { matchProjects, parseQuickAdd } from "./quickadd";
import type { Project } from "./types";

// Monday 23 Nov 2026, 10:30 local.
const REF = new Date(2026, 10, 23, 10, 30);

function project(id: string, name: string): Project {
  return {
    id,
    name,
    color: null,
    icon: null,
    description: null,
    sortOrder: 0,
    archivedAt: null,
    createdAt: "",
    updatedAt: "",
    openTasks: 0, doneRecent: 0,
  };
}

const PROJECTS = [
  project("p1", "Kinia – Educator Platform"),
  project("p2", "Kinia – Administration"),
  project("p3", "Personal Projects"),
];

describe("findDate", () => {
  it.each([
    ["call bank tomorrow", "2026-11-24", null, "tomorrow"],
    ["follow up before Friday", "2026-11-27", null, "before Friday"],
    ["send it by friday", "2026-11-27", null, "by friday"],
    ["meeting friday at 3pm", "2026-11-27", "15:00", "friday at 3pm"],
    ["renew on 3 Dec", "2026-12-03", null, "on 3 Dec"],
    ["review next tuesday", "2026-12-01", null, "next tuesday"],
    ["pay rent in 5 days", "2026-11-28", null, "in 5 days"],
  ])("%s", (text, date, time, matched) => {
    const f = findDate(text, REF);
    expect(f?.date).toBe(date);
    expect(f?.time).toBe(time);
    expect(f?.text.toLowerCase()).toBe(matched.toLowerCase());
  });

  it("returns null when there is no date", () => {
    expect(findDate("update the SEPI teacher list", REF)).toBeNull();
  });

  it("resolves a weekday that is today forward, not backward", () => {
    // REF is a Monday; "monday" must not be in the past.
    const f = findDate("standup monday", REF)!;
    expect(dayDiff("2026-11-23", f.date)).toBeGreaterThanOrEqual(0);
  });
});

describe("parseQuickAdd", () => {
  it("extracts date, project, tag and priority", () => {
    const r = parseQuickAdd("Call Niamh friday 3pm #educator @phone !high", PROJECTS, REF);
    expect(r.input).toMatchObject({
      title: "Call Niamh",
      dueDate: "2026-11-27",
      dueTime: "15:00",
      projectId: "p1",
      tags: ["phone"],
      priority: 3,
    });
    expect(r.parts.map((p) => p.kind).sort()).toEqual(["date", "priority", "project", "tag"]);
  });

  it("keeps the Niamh example readable", () => {
    const r = parseQuickAdd(
      "Follow up with Niamh about the updated SEPI teacher list before Friday",
      PROJECTS,
      REF,
    );
    expect(r.input.title).toBe("Follow up with Niamh about the updated SEPI teacher list");
    expect(r.input.dueDate).toBe("2026-11-27");
  });

  it("leaves ambiguous or unknown #words in the title", () => {
    const r = parseQuickAdd("Ask #kinia team", PROJECTS, REF);
    expect(r.input.projectId).toBeNull();
    expect(r.unknownProjects).toEqual(["kinia"]);
    expect(r.input.title).toBe("Ask #kinia team");
  });

  it("ignores unknown !words and keeps plain text", () => {
    const r = parseQuickAdd("Say hi!! !wow", PROJECTS, REF);
    expect(r.input.priority).toBe(0);
    expect(r.input.title).toBe("Say hi!! !wow");
    expect(r.input.dueDate).toBeNull();
  });

  it("does not read #fri as a date", () => {
    const r = parseQuickAdd("Plan #fri", [project("x", "Friday club")], REF);
    expect(r.input.projectId).toBe("x");
    expect(r.input.dueDate).toBeNull();
  });
});

describe("helpers", () => {
  it("matchProjects prefers exact, then prefix of a word", () => {
    expect(matchProjects("admin", PROJECTS).map((p) => p.id)).toEqual(["p2"]);
    expect(matchProjects("personalprojects", PROJECTS).map((p) => p.id)).toEqual(["p3"]);
    expect(matchProjects("kinia", PROJECTS)).toHaveLength(2);
  });

  it("dates", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(dayDiff("2026-11-23", "2026-11-30")).toBe(7);
    expect(relativeDayLabel("2026-11-24", "2026-11-23")).toBe("Tomorrow");
    expect(relativeDayLabel("2026-11-22", "2026-11-23")).toBe("Yesterday");
  });
});
