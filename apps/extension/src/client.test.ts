import { beforeEach, describe, expect, it } from "vitest";
import { TetherClient, type Storage, type SuggestionBody } from "./client";

function memory(): Storage & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get<T>(k: string) {
      return structuredClone(data[k]) as T | undefined;
    },
    async set(k: string, v: unknown) {
      if (v === undefined) delete data[k];
      else data[k] = structuredClone(v);
    },
  };
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function fakeFetch(h: Handler) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return h(String(input), init);
  }) as typeof fetch;
  return { fn, calls };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const offline: Handler = () => {
  throw new TypeError("Failed to fetch");
};

const body = (key: string, title = "Follow up with Niamh"): SuggestionBody => ({
  kind: "task",
  origin: "chrome",
  payload: { title },
  dedupeKey: key,
  capturedAt: "2026-11-20T09:00:00.000Z",
});

describe("TetherClient", () => {
  let store: ReturnType<typeof memory>;
  beforeEach(() => {
    store = memory();
  });

  it("pairs with a code and stores the token", async () => {
    const f = fakeFetch((url) => (url.endsWith("/v1/pair") ? json(200, { token: "t".repeat(64) }) : json(200, [])));
    const c = new TetherClient(store, f.fn);
    expect(await c.pair("123456")).toEqual({ ok: true });
    expect(await c.token()).toBe("t".repeat(64));
    expect(JSON.parse(String(f.calls[0].init?.body))).toEqual({ code: "123456" });
  });

  it("reports a wrong code with the server's message", async () => {
    const f = fakeFetch(() => json(400, { code: "invalid", message: "That code is wrong or expired" }));
    const c = new TetherClient(store, f.fn);
    expect(await c.pair("000000")).toEqual({ ok: false, message: "That code is wrong or expired" });
    expect(await c.token()).toBeUndefined();
  });

  it("sends with the bearer token", async () => {
    await store.set("token", "abc");
    const f = fakeFetch(() => json(201, { id: "s1" }));
    const c = new TetherClient(store, f.fn);
    expect(await c.capture(body("k1"))).toBe("sent");
    expect((f.calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer abc");
    expect((await c.recent())[0]).toMatchObject({ title: "Follow up with Niamh", state: "sent" });
  });

  it("queues while Tether is closed and flushes later in order", async () => {
    await store.set("token", "abc");
    let up = false;
    const sent: string[] = [];
    const f = fakeFetch((_u, init) => {
      if (!up) return offline("", init);
      sent.push(JSON.parse(String(init?.body)).dedupeKey);
      return json(201, {});
    });
    const c = new TetherClient(store, f.fn);
    expect(await c.capture(body("k1"))).toBe("queued");
    expect(await c.capture(body("k2"))).toBe("queued");
    expect(await c.capture(body("k1"))).toBe("queued"); // same capture twice: one queue entry
    expect((await c.queue()).map((q) => q.body.dedupeKey)).toEqual(["k2", "k1"]);

    expect(await c.flush()).toMatchObject({ sent: 0, left: 2 });
    up = true;
    expect(await c.flush()).toEqual({ sent: 2, left: 0, dropped: 0 });
    expect(sent).toEqual(["k2", "k1"]);
    expect(await c.queue()).toEqual([]);
  });

  it("queues captures made before pairing, sends them once paired", async () => {
    const f = fakeFetch((url) => (url.endsWith("/v1/pair") ? json(200, { token: "tok" }) : json(201, {})));
    const c = new TetherClient(store, f.fn);
    expect(await c.capture(body("k1"))).toBe("queued");
    await c.pair("123456");
    expect(await c.queue()).toEqual([]);
    expect((await c.recent())[0].state).toBe("sent");
  });

  it("drops items the server rejects as invalid, keeps 5xx for retry", async () => {
    await store.set("token", "abc");
    await store.set("queue", [
      { body: body("bad", " "), addedAt: "", attempts: 1 },
      { body: body("later"), addedAt: "", attempts: 1 },
    ]);
    const f = fakeFetch((_u, init) =>
      JSON.parse(String(init?.body)).dedupeKey === "bad" ? json(400, { message: "title is required" }) : json(503, {}),
    );
    const c = new TetherClient(store, f.fn);
    expect(await c.flush()).toEqual({ sent: 0, left: 1, dropped: 1 });
    expect((await c.queue())[0]).toMatchObject({ attempts: 2, lastError: "server" });
  });

  it("an unauthorised reply keeps the item, forgets the token and asks to pair again", async () => {
    await store.set("token", "old");
    const f = fakeFetch((url) => (url.endsWith("/v1/pair") ? json(200, { token: "new" }) : url.includes("suggestions") && f.calls.length < 2 ? json(403, {}) : json(201, {})));
    const c = new TetherClient(store, f.fn);
    expect(await c.capture(body("k1"))).toBe("queued");
    expect(await c.token()).toBeUndefined();
    expect(await c.needsRepair()).toBe(true);
    await c.pair("123456");
    expect(await c.needsRepair()).toBe(false);
    expect(await c.queue()).toEqual([]);
  });

  it("keeps the capture time in queued items", async () => {
    await store.set("token", "abc");
    let sentBody: { capturedAt?: string } = {};
    let up = false;
    const c = new TetherClient(
      store,
      fakeFetch((_u, init) => {
        if (!up) return offline("", init);
        sentBody = JSON.parse(String(init?.body));
        return json(201, {});
      }).fn,
    );
    await c.capture(body("k1"));
    up = true;
    await c.flush();
    expect(sentBody.capturedAt).toBe("2026-11-20T09:00:00.000Z");
  });

  it("a capture during a flush is not lost", async () => {
    await store.set("token", "abc");
    await store.set("queue", [{ body: body("old"), addedAt: "", attempts: 1 }]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const c = new TetherClient(
      store,
      fakeFetch(async () => {
        if (first) {
          first = false;
          await gate; // flush is mid-send
        }
        return json(503, {});
      }).fn,
    );
    const flushing = c.flush();
    const capturing = c.capture(body("new"));
    release();
    await Promise.all([flushing, capturing]);
    expect((await c.queue()).map((q) => q.body.dedupeKey).sort()).toEqual(["new", "old"]);
  });

  it("caps recent captures at 10", async () => {
    await store.set("token", "abc");
    const c = new TetherClient(store, fakeFetch(() => json(201, {})).fn);
    for (let i = 0; i < 12; i++) await c.capture(body(`k${i}`, `T${i}`));
    const r = await c.recent();
    expect(r).toHaveLength(10);
    expect(r[0].title).toBe("T11");
  });
});
