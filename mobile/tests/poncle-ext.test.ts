/**
 * Bridge extension (android/app/src/main/assets/poncle-ext) — audit 2026-11-17
 * I7 / U3. background.js is a plain (non-module) WebExtension script, so it is
 * loaded here as-is with a fake `browser` and a manual timer queue; nothing in
 * the shipped file is changed for testability.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkExtLock, extDigest, readExtFiles, readLock, EXT_DIR } from "../scripts/poncle-ext-lock.mjs";

const BG_SRC = readFileSync(join(EXT_DIR, "background.js"), "utf8");

type Listener = (m: unknown) => void;
interface FakePort {
  sent: unknown[];
  msgListeners: Listener[];
  discListeners: Array<() => void>;
  postMessage(m: unknown): void;
  onMessage: { addListener(l: Listener): void };
  onDisconnect: { addListener(l: () => void): void };
}

interface Cookie {
  name: string;
  value?: string;
  domain: string;
  hostOnly?: boolean;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  session?: boolean;
  sameSite?: string;
  expirationDate?: number;
}

function makePort(): FakePort {
  const p: FakePort = {
    sent: [],
    msgListeners: [],
    discListeners: [],
    postMessage(m) {
      p.sent.push(m);
    },
    onMessage: { addListener: (l) => p.msgListeners.push(l) },
    onDisconnect: { addListener: (l) => p.discListeners.push(l) },
  };
  return p;
}

interface Bg {
  allowed(c: unknown): boolean;
  toPlain(c: Cookie): Record<string, unknown>;
  ports: FakePort[];
  timers: Array<{ fn: () => void; ms: number }>;
  jar: Cookie[];
  setCalls: Cookie[];
  removeCalls: Array<{ url: string; name: string }>;
  runTimers(): void;
  disconnect(): void;
  deliver(m: unknown): Promise<void>;
  last(): FakePort;
}

function loadBackground(jar: Cookie[] = []): Bg {
  const ports: FakePort[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const setCalls: Cookie[] = [];
  const removeCalls: Array<{ url: string; name: string }> = [];
  const browser = {
    runtime: {
      connectNative: (name: string) => {
        expect(name).toBe("bg");
        const p = makePort();
        ports.push(p);
        return p;
      },
    },
    cookies: {
      getAll: async (q: { url?: string; domain?: string }) =>
        q.url ? jar.filter((c) => (c.path || "/") === "/") : jar.filter((c) => c.domain.replace(/^\./, "") === q.domain),
      set: async (d: Cookie) => {
        setCalls.push(d);
      },
      remove: async (d: { url: string; name: string }) => {
        removeCalls.push(d);
        const i = jar.findIndex((c) => c.name === d.name);
        if (i >= 0) jar.splice(i, 1);
      },
    },
  };
  const fakeSetTimeout = (fn: () => void, ms: number) => {
    timers.push({ fn, ms });
    return timers.length;
  };
  const factory = new Function(
    "browser",
    "setTimeout",
    `${BG_SRC}\n;return { allowed, toPlain };`,
  ) as (b: unknown, st: unknown) => Pick<Bg, "allowed" | "toPlain">;
  const api = factory(browser, fakeSetTimeout);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    ...api,
    ports,
    timers,
    jar,
    setCalls,
    removeCalls,
    runTimers() {
      const due = timers.splice(0, timers.length);
      for (const t of due) t.fn();
    },
    disconnect() {
      for (const l of ports[ports.length - 1].discListeners) l();
    },
    async deliver(m) {
      for (const l of ports[ports.length - 1].msgListeners) l(m);
      await flush();
      await flush();
    },
    last: () => ports[ports.length - 1],
  };
}

describe("background.js: cookie scope", () => {
  const bg = loadBackground();
  it("allows only m.poncle.co.kr host cookies and poncle.co.kr domain cookies", () => {
    expect(bg.allowed({ name: "S", domain: "m.poncle.co.kr", hostOnly: true })).toBe(true);
    expect(bg.allowed({ name: "S", domain: ".poncle.co.kr", hostOnly: false })).toBe(true);
    expect(bg.allowed({ name: "S", domain: "poncle.co.kr", hostOnly: true })).toBe(false);
    expect(bg.allowed({ name: "S", domain: "evil.com", hostOnly: false })).toBe(false);
    expect(bg.allowed({ name: "", domain: "m.poncle.co.kr", hostOnly: true })).toBe(false);
    expect(bg.allowed(null)).toBe(false);
  });

  it("toPlain keeps expiry only for persistent cookies and only known sameSite values", () => {
    const o = bg.toPlain({ name: "a", value: "v", domain: "m.poncle.co.kr", session: true, expirationDate: 9, sameSite: "weird" });
    expect(o.expirationDate).toBeUndefined();
    expect(o.sameSite).toBeUndefined();
    const p = bg.toPlain({ name: "a", domain: "m.poncle.co.kr", expirationDate: 9, sameSite: "lax" });
    expect(p.expirationDate).toBe(9);
    expect(p.sameSite).toBe("lax");
    expect(p.path).toBe("/");
  });
});

describe("background.js: commands over the bg port", () => {
  it("says hello on connect", () => {
    const bg = loadBackground();
    expect(bg.last().sent).toContainEqual({ kind: "hello" });
  });

  it("import skips foreign and already-expired cookies; replies with the count", async () => {
    const bg = loadBackground();
    const now = Date.now() / 1000;
    await bg.deliver({
      id: 7,
      cmd: "import",
      cookies: [
        { name: "ok", value: "1", domain: "m.poncle.co.kr", hostOnly: true, path: "/" },
        { name: "old", value: "1", domain: "m.poncle.co.kr", hostOnly: true, expirationDate: now - 10 },
        { name: "x", value: "1", domain: "evil.com", hostOnly: true },
      ],
    });
    expect(bg.setCalls.map((c) => c.name)).toEqual(["ok"]);
    expect(bg.last().sent).toContainEqual({ id: 7, kind: "imported", n: 1 });
  });

  it("export de-duplicates the url and domain queries", async () => {
    const bg = loadBackground([{ name: "S", value: "v", domain: "m.poncle.co.kr", hostOnly: true, path: "/" }]);
    await bg.deliver({ id: 1, cmd: "export" });
    const r = bg.last().sent.find((m) => (m as { id?: number }).id === 1) as { kind: string; cookies: unknown[] };
    expect(r.kind).toBe("export");
    expect(r.cookies).toHaveLength(1);
  });

  it("clear reports how many cookies are left", async () => {
    const bg = loadBackground([{ name: "S", value: "v", domain: "m.poncle.co.kr", hostOnly: true, path: "/" }]);
    await bg.deliver({ id: 3, cmd: "clear" });
    expect(bg.last().sent).toContainEqual({ id: 3, kind: "cleared", n: 1, left: 0 });
  });

  it("an unknown command is an error reply; a message without a numeric id is ignored", async () => {
    const bg = loadBackground();
    await bg.deliver({ id: 4, cmd: "nope" });
    await bg.deliver({ cmd: "export" });
    const replies = bg.last().sent.filter((m) => (m as { kind: string }).kind !== "hello");
    expect(replies).toEqual([{ id: 4, kind: "error" }]);
  });
});

describe("background.js: reconnect budget (U3)", () => {
  it("stops retrying after a bounded number of immediate disconnects", () => {
    const bg = loadBackground();
    for (let i = 0; i < 100; i++) {
      bg.disconnect();
      bg.runTimers();
    }
    const total = bg.ports.length;
    expect(total).toBeGreaterThan(1);
    expect(total).toBeLessThan(40);
  });

  it("a port the app actually talked on resets the budget, so later drops still reconnect", async () => {
    const bg = loadBackground();
    for (let i = 0; i < 60; i++) {
      await bg.deliver({ id: i, cmd: "nope" }); // the app answered: the port was live
      bg.disconnect();
      // run only the reconnect (a 1 s retry); the port is replaced
      const retry = bg.timers.filter((t) => t.ms <= 1000);
      bg.timers.length = 0;
      for (const t of retry) t.fn();
    }
    expect(bg.ports.length).toBe(61);
  });

  it("a port that stayed connected for a while also resets the budget", () => {
    const bg = loadBackground();
    for (let i = 0; i < 60; i++) {
      // the stability timer of the current port fires before it drops
      const stable = bg.timers.filter((t) => t.ms > 1000);
      bg.timers.length = 0;
      for (const t of stable) t.fn();
      bg.disconnect();
      bg.runTimers();
    }
    expect(bg.ports.length).toBe(61);
  });
});

describe("poncle-ext manifest version guard (I7)", () => {
  it("the recorded lock matches the shipped files — bump manifest version + run `node scripts/poncle-ext-lock.mjs` after ANY change in poncle-ext/", () => {
    const files = readExtFiles();
    const res = checkExtLock(readLock(), files);
    expect(res.reason).toBe("");
    expect(res.ok).toBe(true);
  });

  it("flags content changes without a version bump", () => {
    const files = new Map([
      ["manifest.json", JSON.stringify({ version: "1.0.5" })],
      ["background.js", "a"],
    ]);
    const lock = { version: "1.0.5", sha256: extDigest(files) };
    expect(checkExtLock(lock, files).ok).toBe(true);
    const changed = new Map(files).set("background.js", "b");
    const r = checkExtLock(lock, changed);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("version");
  });

  it("flags a bumped version that was not recorded, and a version that went down", () => {
    const files = new Map([["manifest.json", JSON.stringify({ version: "1.0.6" })]]);
    expect(checkExtLock({ version: "1.0.5", sha256: "x" }, files).ok).toBe(false);
    expect(checkExtLock({ version: "1.0.7", sha256: "x" }, files).ok).toBe(false);
  });

  it("the digest ignores CRLF vs LF checkouts", () => {
    const lf = new Map([["a.js", "x\ny\n"]]);
    const crlf = new Map([["a.js", "x\r\ny\r\n"]]);
    expect(extDigest(lf)).toBe(extDigest(crlf));
  });
});
