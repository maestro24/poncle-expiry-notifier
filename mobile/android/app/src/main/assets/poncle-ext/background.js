// Poncle bridge — background script (runs once per GeckoRuntime).
//
// Exports / imports / clears the app's Poncle cookies (including the HttpOnly
// session cookie, which no page script can read) so a login survives the app
// process being killed: GeckoHost persists the export encrypted on-device
// (CookieStore) and imports it back on the next start, before any Poncle page
// loads. Only cookies sendable to m.poncle.co.kr are touched; the manifest's
// host permission limits the cookies API to that host anyway.
//
// Commands arrive ONLY over the native port "bg" ({id, cmd}); every reply
// echoes the id. Cookie names/values are never logged.
"use strict";

const HOST = "m.poncle.co.kr";
const BASE = "https://" + HOST + "/";
const PARENT = "poncle.co.kr";
const MAX_COOKIES = 64;
const SAME_SITE = ["no_restriction", "lax", "strict"];

// Reconnect budget for ports that drop right away (no app delegate yet). It is
// a budget for CONSECUTIVE failures only (audit U3): a port the app talked on,
// or one that stayed up for STABLE_MS, proves the delegate exists and resets it,
// so a long-lived process survives any number of later, spaced-out drops.
const MAX_RETRIES = 30;
const RETRY_MS = 1000;
const STABLE_MS = 5000;

let port = null;
let retries = 0;

function stripDot(d) {
  return String(d || "").replace(/^\./, "").toLowerCase();
}

/** Host-only cookies must belong to m.poncle.co.kr; domain cookies may be set on
 *  m.poncle.co.kr or its parent poncle.co.kr (both are sent to m.poncle.co.kr). */
function allowed(c) {
  if (!c || typeof c.name !== "string" || c.name === "") return false;
  const host = stripDot(c.domain);
  if (c.hostOnly) return host === HOST;
  return host === HOST || host === PARENT;
}

function toPlain(c) {
  const o = {
    name: c.name,
    value: String(c.value || ""),
    domain: c.domain,
    hostOnly: !!c.hostOnly,
    path: c.path || "/",
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    session: !!c.session,
  };
  if (SAME_SITE.includes(c.sameSite)) o.sameSite = c.sameSite;
  if (!c.session && typeof c.expirationDate === "number") o.expirationDate = c.expirationDate;
  return o;
}

/** Every Poncle cookie sent to m.poncle.co.kr: the url query returns the
 *  root-path host + parent-domain cookies, the domain query adds host cookies
 *  with a deeper path. De-duplicated by name/domain/path. */
async function collect() {
  const lists = await Promise.all([
    browser.cookies.getAll({ url: BASE }),
    browser.cookies.getAll({ domain: HOST }),
  ]);
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const c of list || []) {
      if (!allowed(c)) continue;
      const key = c.name + "\u0000" + stripDot(c.domain) + "\u0000" + (c.path || "/") + "\u0000" + !!c.hostOnly;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
      if (out.length >= MAX_COOKIES) return out;
    }
  }
  return out;
}

function urlFor(c) {
  const path = typeof c.path === "string" && c.path.startsWith("/") ? c.path : "/";
  return "https://" + HOST + path;
}

async function importAll(cookies) {
  let n = 0;
  const nowSec = Date.now() / 1000;
  for (const c of (Array.isArray(cookies) ? cookies : []).slice(0, MAX_COOKIES)) {
    if (!allowed(c)) continue;
    // A persistent cookie that has already expired would only be deleted again.
    if (typeof c.expirationDate === "number" && c.expirationDate <= nowSec) continue;
    const d = {
      url: urlFor(c),
      name: c.name,
      value: String(c.value || ""),
      path: typeof c.path === "string" && c.path.startsWith("/") ? c.path : "/",
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
    };
    if (!c.hostOnly) d.domain = c.domain;
    if (SAME_SITE.includes(c.sameSite)) d.sameSite = c.sameSite;
    if (typeof c.expirationDate === "number") d.expirationDate = c.expirationDate;
    try {
      await browser.cookies.set(d);
      n++;
    } catch (e) {
      // one bad entry must not stop the rest of the restore
    }
  }
  return n;
}

async function clearAll() {
  let n = 0;
  for (const c of await collect()) {
    try {
      await browser.cookies.remove({ url: urlFor(c), name: c.name });
      n++;
    } catch (e) {
      // keep going
    }
  }
  return n;
}

async function onMessage(msg) {
  retries = 0; // the app is attached and talking on this port
  if (!msg || typeof msg !== "object" || typeof msg.id !== "number") return;
  const id = msg.id;
  try {
    if (msg.cmd === "export") {
      const cookies = (await collect()).map(toPlain);
      reply({ id, kind: "export", cookies });
    } else if (msg.cmd === "import") {
      reply({ id, kind: "imported", n: await importAll(msg.cookies) });
    } else if (msg.cmd === "clear") {
      const n = await clearAll();
      // Re-read so the app can verify nothing survived (a failed remove is
      // swallowed per cookie above); left > 0 makes the app report failure.
      const left = (await collect()).length;
      reply({ id, kind: "cleared", n, left });
    } else {
      reply({ id, kind: "error" });
    }
  } catch (e) {
    reply({ id, kind: "error" }); // no error text: it could echo cookie details
  }
}

function reply(m) {
  try {
    if (port) port.postMessage(m);
  } catch (e) {
    // port gone; the app side times out and treats it as a transient failure
  }
}

function connect() {
  const p = browser.runtime.connectNative("bg");
  port = p;
  p.onMessage.addListener(onMessage);
  p.onDisconnect.addListener(() => {
    if (port === p) port = null;
    // The app (re)attaches its delegate on start; retry a bounded number of
    // consecutive times.
    if (retries++ < MAX_RETRIES) setTimeout(connect, RETRY_MS);
  });
  // Still connected after STABLE_MS: this was a working connection.
  setTimeout(() => {
    if (port === p) retries = 0;
  }, STABLE_MS);
  reply({ kind: "hello" });
}

connect();
