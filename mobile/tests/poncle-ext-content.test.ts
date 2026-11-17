// @vitest-environment happy-dom
/**
 * Bridge content script (poncle-ext/content.js) — audit 2026-11-17 I7. Loaded
 * as-is into a happy-dom page with a fake `browser` port: commands only come
 * over that port, autofill never overwrites typed values (B12), the typed
 * credentials are reported only on a real login submit, and fetch stays
 * same-origin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXT_DIR } from "../scripts/poncle-ext-lock.mjs";

const SRC = readFileSync(join(EXT_DIR, "content.js"), "utf8");

interface Port {
  sent: Array<Record<string, unknown>>;
  listeners: Array<(m: unknown) => void>;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function load(url: string): Port {
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(url);
  const port: Port = { sent: [], listeners: [] };
  const browser = {
    runtime: {
      connectNative: (name: string) => {
        expect(name).toBe("browser");
        return {
          postMessage: (m: Record<string, unknown>) => port.sent.push(m),
          onMessage: { addListener: (l: (m: unknown) => void) => port.listeners.push(l) },
        };
      },
    },
  };
  new Function("browser", SRC)(browser);
  return port;
}

function send(port: Port, m: unknown) {
  for (const l of port.listeners) l(m);
}

beforeEach(() => {
  document.body.innerHTML = `
    <form id="f"><input name="userid"><input name="userpw" type="password">
      <button type="submit" id="go">로그인</button>
      <a href="#" id="find">비밀번호 찾기</a></form>`;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("content.js: login page", () => {
  it("says hello with its path", () => {
    const port = load("https://m.poncle.co.kr/member/login");
    expect(port.sent[0]).toEqual({ kind: "hello", path: "/member/login" });
  });

  it("fills only EMPTY fields — never over what the user already typed (B12)", () => {
    const port = load("https://m.poncle.co.kr/member/login");
    const u = document.querySelector<HTMLInputElement>('input[name="userid"]')!;
    const p = document.querySelector<HTMLInputElement>('input[name="userpw"]')!;
    u.value = "typed-id";
    send(port, { cmd: "login", uid: "saved-id", pw: "saved-pw" });
    expect(u.value).toBe("typed-id");
    expect(p.value).toBe("saved-pw");
  });

  it("does not fill on a non-login page", () => {
    const port = load("https://m.poncle.co.kr/open/mobile");
    send(port, { cmd: "login", uid: "saved-id", pw: "saved-pw" });
    expect(document.querySelector<HTMLInputElement>('input[name="userid"]')!.value).toBe("");
  });

  it("reports the typed values on the login button, not on 비밀번호 찾기", () => {
    const port = load("https://m.poncle.co.kr/member/login");
    send(port, { cmd: "login" });
    document.querySelector<HTMLInputElement>('input[name="userid"]')!.value = "me";
    document.querySelector<HTMLInputElement>('input[name="userpw"]')!.value = "secret";
    document.getElementById("find")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(port.sent.filter((m) => m.kind === "capture")).toHaveLength(0);
    document.getElementById("go")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // The click and the form's submit event may both report (same values; the
    // app keeps the last pending pair).
    const caps = port.sent.filter((m) => m.kind === "capture");
    expect(caps.length).toBeGreaterThanOrEqual(1);
    for (const c of caps) expect(c).toEqual({ kind: "capture", uid: "me", pw: "secret" });
  });

  it("ignores malformed messages", () => {
    const port = load("https://m.poncle.co.kr/member/login");
    send(port, null);
    send(port, "login");
    send(port, { cmd: "fetch" }); // no numeric id
    expect(port.sent).toHaveLength(1); // only hello
  });
});

describe("content.js: fetch", () => {
  it("refuses a cross-origin path without touching the network", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const port = load("https://m.poncle.co.kr/open/mobile");
    send(port, { id: 1, cmd: "fetch", path: "https://evil.example/steal" });
    await flush();
    expect(f).not.toHaveBeenCalled();
    expect(port.sent).toContainEqual({ id: 1, kind: "fetch", ok: false });
  });

  it("returns status, Date and body of a same-origin 200; error pages are not read", async () => {
    const ok = { status: 200, headers: new Headers({ Date: "Mon, 17 Nov 2026 01:00:00 GMT" }), text: async () => "[1]" };
    const notFound = { status: 404, headers: new Headers(), text: vi.fn(async () => "secret error page") };
    const f = vi.fn().mockResolvedValueOnce(ok).mockResolvedValueOnce(notFound);
    vi.stubGlobal("fetch", f);
    const port = load("https://m.poncle.co.kr/open/mobile");
    send(port, { id: 2, cmd: "fetch", path: "/open/listOpen?x=1", referer: "/open/mobile" });
    await flush();
    await flush();
    send(port, { id: 3, cmd: "fetch", path: "/open/listOpen" });
    await flush();
    await flush();
    expect(f.mock.calls[0][0]).toBe("https://m.poncle.co.kr/open/listOpen?x=1");
    expect(f.mock.calls[0][1]).toMatchObject({ method: "GET", credentials: "include" });
    expect(port.sent).toContainEqual({ id: 2, kind: "fetch", ok: true, status: 200, date: "Mon, 17 Nov 2026 01:00:00 GMT", body: "[1]" });
    expect(port.sent).toContainEqual({ id: 3, kind: "fetch", ok: true, status: 404, date: "", body: "" });
    expect(notFound.text).not.toHaveBeenCalled();
  });

  it("a network failure is ok:false (transient), never an expiry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const port = load("https://m.poncle.co.kr/open/mobile");
    send(port, { id: 4, cmd: "fetch", path: "/open/listOpen" });
    await flush();
    await flush();
    expect(port.sent).toContainEqual({ id: 4, kind: "fetch", ok: false });
  });
});
