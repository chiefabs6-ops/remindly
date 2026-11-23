import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chooseDir, repoNameFromRemote, rootFromUri, safeRemote } from "./project.js";

describe("project detection", () => {
  it("prefers explicit dir, then roots, then CLAUDE_PROJECT_DIR, then cwd", () => {
    expect(chooseDir({ explicit: "C:\\a", roots: ["C:\\b"], env: { CLAUDE_PROJECT_DIR: "C:\\c" }, cwd: "C:\\d" })).toBe("C:\\a");
    expect(chooseDir({ roots: ["C:\\b"], env: { CLAUDE_PROJECT_DIR: "C:\\c" }, cwd: "C:\\d" })).toBe("C:\\b");
    expect(chooseDir({ roots: [], env: { CLAUDE_PROJECT_DIR: "C:\\c" }, cwd: "C:\\d" })).toBe("C:\\c");
    expect(chooseDir({ env: {}, cwd: "C:\\d" })).toBe("C:\\d");
  });

  it("names repos from their remote and strips credentials", () => {
    expect(repoNameFromRemote("https://github.com/acme/educator-platform.git")).toBe("educator-platform");
    expect(repoNameFromRemote("git@github.com:acme/admin.git")).toBe("admin");
    expect(repoNameFromRemote(null)).toBeNull();
    expect(safeRemote("https://user:secret@github.com/acme/x.git")).toBe("https://github.com/acme/x.git");
  });

  it("reads file:// roots", () => {
    expect(rootFromUri("file:///C:/Code/Educator")).toBe("C:\\Code\\Educator");
    expect(rootFromUri("https://example.com")).toBeNull();
  });
});

describe("suggest()", () => {
  it("spools to disk when Tether is not reachable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tether-plugin-"));
    process.env.TETHER_DATA_DIR = dir;
    process.env.TETHER_API = "http://127.0.0.1:9"; // nothing listens on the discard port
    await writeFile(join(dir, "token"), "t".repeat(64));
    const { suggest } = await import("./tether.js");
    const r = await suggest({ kind: "task", origin: "claude", payload: { title: "Finish profile" }, dedupeKey: "claude:abc12345" });
    expect(r.state).toBe("spooled");
    const files = await readdir(join(dir, "spool"));
    expect(files).toHaveLength(1);
    expect(files[0].endsWith(".json")).toBe(true);
    const saved = JSON.parse(await readFile(join(dir, "spool", files[0]), "utf8"));
    expect(saved).toMatchObject({ kind: "task", origin: "claude", dedupeKey: "claude:abc12345" });
  });

  it("dedupe keys are stable", async () => {
    const { dedupeKey } = await import("./tether.js");
    expect(dedupeKey(["a", ["b"]])).toBe(dedupeKey(["a", ["b"]]));
    expect(dedupeKey(["a"])).not.toBe(dedupeKey(["b"]));
  });
});
