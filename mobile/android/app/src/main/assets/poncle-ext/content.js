// Poncle bridge — content script (top frame of every https://m.poncle.co.kr page
// in the app's GeckoView sessions: the hidden worker and the login screen).
//
// Commands come ONLY from the app over the native port "browser" (each session
// has its own app-side delegate). The page itself, frames and window messages
// can never issue a command. Nothing here logs ids, passwords or response bodies.
//
//   {id, cmd:"fetch", path, referer} -> ONE same-origin GET with the page's own
//       session (content.fetch = page principal, so Poncle sees an ordinary
//       XHR from its own page). Reply {id, kind:"fetch", ok, status, date, body}.
//   {cmd:"login", uid?, pw?}          -> login page only: optionally fill the
//       saved id/password, report the typed values on a REAL login submit
//       ({kind:"capture"}) and report Poncle's procLogin answer
//       ({kind:"procLogin", result}) observed by a read-only page hook
//       (inline page script; Xray hook if the page CSP blocks inline scripts),
//       and {kind:"loginStalled"} when the password was cleared after a submit
//       but no procLogin answer was seen.
"use strict";

(function () {
  const MAX_BODY = 32 * 1024 * 1024;
  let port;
  try {
    port = browser.runtime.connectNative("browser");
  } catch (e) {
    return; // no app delegate for this session: stay inert
  }

  function post(m) {
    try {
      port.postMessage(m);
    } catch (e) {
      // port closed (page unloading): the app treats the request as transient
    }
  }

  // ---- authenticated same-origin GET --------------------------------------
  async function doFetch(msg) {
    const id = msg.id;
    try {
      const url = new URL(String(msg.path || ""), location.href);
      if (url.origin !== location.origin) throw new Error("origin");
      const init = {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "follow",
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "application/json, text/javascript, */*; q=0.01",
        },
      };
      if (typeof msg.referer === "string" && msg.referer) {
        const ref = new URL(msg.referer, location.href);
        if (ref.origin === location.origin) init.referrer = ref.href;
      }
      const f = (typeof content !== "undefined" && content.fetch) ? content.fetch : fetch;
      let r;
      try {
        r = await f(url.href, init);
      } catch (first) {
        // Retry the idempotent GET once without the custom referrer, in case the
        // engine refused that option; a real network failure fails again below.
        if (!init.referrer) throw first;
        delete init.referrer;
        r = await f(url.href, init);
      }
      const date = r.headers.get("Date") || "";
      let body = "";
      // Only a 200 can carry data; error pages are never read.
      if (r.status === 200) {
        body = await r.text();
        if (body.length > MAX_BODY) {
          post({ id, kind: "fetch", ok: false });
          return;
        }
      }
      post({ id, kind: "fetch", ok: true, status: r.status, date, body });
    } catch (e) {
      // No response at all (offline, DNS, aborted): a network error, not an expiry.
      post({ id, kind: "fetch", ok: false });
    }
  }

  // ---- login page ----------------------------------------------------------
  const isLoginPage = /\/member\/login/.test(location.pathname);
  let loginArmed = false;

  function U() { return document.querySelector('input[name="userid"]'); }
  function P() { return document.querySelector('input[name="userpw"]'); }

  /** Autofill one field ONLY when it is still empty: the script now runs at
   *  document_end (before reCAPTCHA & co. finish loading), so the user may
   *  already be typing — a saved value must never overwrite what they typed
   *  (e.g. a new password that would otherwise be replaced by the stale one). */
  function fill(el, v) {
    if (!el || typeof v !== "string" || !v) return;
    if (el.value) return;
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Fill the saved id/password now, and once more after 'load' in case the
   *  login form is rendered by a page script after document_end. */
  function fillSaved(msg) {
    const run = () => {
      fill(U(), msg.uid);
      fill(P(), msg.pw);
    };
    run();
    if (document.readyState !== "complete" && (!U() || !P())) {
      window.addEventListener("load", run, { once: true });
    }
  }

  /** Report the typed id/password (only called on a real login submit). */
  function capture() {
    const u = U();
    const p = P();
    if (p && p.value) {
      post({ kind: "capture", uid: u ? String(u.value || "") : "", pw: String(p.value) });
      watchForStall();
    }
  }

  /** True only for the login form's submit control or a control labelled
   *  로그인/login — never 비밀번호 찾기, 회원가입, 로그인 유지, the page body. */
  function isLoginControl(el) {
    if (!el || !el.closest) return false;
    const t = el.closest('button,input[type="submit"],input[type="image"],input[type="button"],a,[role="button"],[onclick]');
    if (!t) return false;
    const lab = ((t.innerText || "") + " " + (t.value || "") + " " + (t.id || "") + " "
      + (t.getAttribute("class") || "") + " " + (t.getAttribute("onclick") || "") + " "
      + (t.getAttribute("href") || "")).toLowerCase();
    if (/찾기|find|join|가입|regist|sign ?up|유지|keep|remember|저장|save/.test(lab)) return false;
    const p = P();
    const f = p && p.form;
    const ty = t.tagName === "A" ? "" : String(t.type || "").toLowerCase();
    if (f && t.form === f && (ty === "submit" || ty === "image")) return true;
    return /로그인|login|log in|sign ?in/.test(lab);
  }

  function installCapture() {
    document.addEventListener("submit", (e) => {
      const p = P();
      if (p && e.target && (e.target === p.form || (e.target.contains && e.target.contains(p)))) capture();
    }, true);
    document.addEventListener("click", (e) => { if (isLoginControl(e.target)) capture(); }, true);
    // Delegated (not bound to the fields) so a form rendered after document_end
    // is covered too.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const t = e.target;
      if (t && (t === P() || t === U())) capture();
    }, true);
  }

  /** Runs in the PAGE (content scripts cannot see the page's XHR). It only
   *  OBSERVES the page's own XMLHttpRequest / fetch to /member/procLogin: the
   *  request and the page's response are untouched; a 'load' listener / a
   *  cloned response is read and ONLY {result, msg} is posted back, tagged with
   *  a per-page nonce. The reCAPTCHA is never touched. */
  function pageObserver(N) {
    if (window.__plObs) return;
    window.__plObs = 1;
    function M(u) {
      try {
        var s = (u && typeof u === "object" && u.url) ? u.url : String(u || "");
        var p;
        try { p = new URL(s, location.href).pathname; } catch (e) { p = s.split(/[?#]/)[0]; }
        return /\/member\/procLogin(\.[a-z]+)?\/?$/i.test(p);
      } catch (e) { return false; }
    }
    function R(b) {
      var r = null, m = "";
      try {
        var s = String(b || "");
        if (s.length <= 16384) {
          var a = s.indexOf("{"), z = s.lastIndexOf("}");
          if (a >= 0 && z > a) {
            var j = JSON.parse(s.slice(a, z + 1));
            if (j && (typeof j.result === "number" || typeof j.result === "string")) r = j.result;
            if (j && typeof j.msg === "string") m = j.msg.slice(0, 200);
          }
        }
      } catch (e) { r = null; }
      try { window.postMessage(JSON.stringify({ n: N, r: r, m: m }), location.origin); } catch (e) {}
    }
    try {
      var X = XMLHttpRequest.prototype, o = X.open, sd = X.send;
      X.open = function (m, u) { try { this.__plUrl = u; } catch (e) {} return o.apply(this, arguments); };
      X.send = function () {
        try {
          var x = this;
          if (M(x.__plUrl)) {
            x.addEventListener("load", function () {
              var b;
              try { b = x.responseText; } catch (e) {
                try { b = typeof x.response === "string" ? x.response : JSON.stringify(x.response); } catch (e2) {}
              }
              R(b);
            });
          }
        } catch (e) {}
        return sd.apply(this, arguments);
      };
    } catch (e) {}
    try {
      var F = window.fetch;
      if (typeof F === "function") {
        window.fetch = function (i) {
          var pr = F.apply(this, arguments);
          try {
            if (M(i)) pr.then(function (r) { try { r.clone().text().then(R, function () {}); } catch (e) {} }, function () {});
          } catch (e) {}
          return pr;
        };
      }
    } catch (e) {}
  }

  // procLogin answers reported to the app since the last login submit.
  let resultSeen = false;
  let stallTimer = 0;

  function reportResult(r) {
    resultSeen = true;
    post({ kind: "procLogin", result: (typeof r === "number" || typeof r === "string") ? r : null });
  }

  /** CSP fallback: Firefox applies the page's CSP to inline scripts injected by
   *  content scripts, so if Poncle ever ships a script-src without
   *  'unsafe-inline' the page-context observer above never runs. Then hook the
   *  page's XMLHttpRequest.open through Xray (wrappedJSObject + exportFunction,
   *  which no CSP governs). Same contract: observe /member/procLogin only, leave
   *  the request and the page's response untouched, report only the result. */
  function installObserverXray() {
    try {
      const W = window.wrappedJSObject;
      if (!W || typeof exportFunction !== "function") return false;
      if (W.__plObs) return true;
      const X = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
      if (!X) return false;
      const open = X.open;
      X.open = exportFunction(function (m, u) {
        try {
          const xhr = this;
          let path = "";
          try { path = new URL(String(u), location.href).pathname; } catch (e) { path = String(u || "").split(/[?#]/)[0]; }
          if (/\/member\/procLogin(\.[a-z]+)?\/?$/i.test(path)) {
            xhr.addEventListener("load", () => {
              let r = null;
              try {
                const b = String(xhr.responseText || "");
                if (b.length <= 16384) {
                  const a = b.indexOf("{"), z = b.lastIndexOf("}");
                  if (a >= 0 && z > a) {
                    const j = JSON.parse(b.slice(a, z + 1));
                    if (j && (typeof j.result === "number" || typeof j.result === "string")) r = j.result;
                  }
                }
              } catch (e) { r = null; }
              reportResult(r);
            });
          }
        } catch (e) {}
        return open.apply(this, arguments);
      }, W);
      W.__plObs = 1;
      return true;
    } catch (e) {
      return false;
    }
  }

  function installObserver() {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    const nonce = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
    window.addEventListener("message", (e) => {
      if (e.source !== window || typeof e.data !== "string") return;
      let d;
      try { d = JSON.parse(e.data); } catch (err) { return; }
      if (!d || d.n !== nonce) return;
      // Only the result code goes to the app (msg stays in the page).
      reportResult(d.r);
    });
    try {
      const s = document.createElement("script");
      s.textContent = "(" + pageObserver.toString() + ")(" + JSON.stringify(nonce) + ");";
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch (e) {
      // fall through to the check below
    }
    // An allowed inline script runs synchronously on insertion and sets the
    // page flag; if it is missing, the page CSP blocked it.
    let installed = false;
    try { installed = !!(window.wrappedJSObject && window.wrappedJSObject.__plObs); } catch (e) { installed = false; }
    if (!installed) installObserverXray();
  }

  /** After a real login submit: if Poncle cleared the password field and no
   *  procLogin answer was observed (observer blocked, or an unexpected reply),
   *  tell the app so it can show a generic notice instead of leaving the user
   *  with a silently emptied form. A successful login navigates away first,
   *  which ends this document and its timer. */
  function watchForStall() {
    resultSeen = false;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stallTimer = 0;
      const p = P();
      if (!resultSeen && p && !p.value) post({ kind: "loginStalled" });
    }, 10000);
  }

  function armLogin(msg) {
    if (!isLoginPage) return;
    fillSaved(msg);
    if (loginArmed) return;
    loginArmed = true;
    installCapture();
    installObserver();
  }

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.cmd === "fetch" && typeof msg.id === "number") doFetch(msg);
    else if (msg.cmd === "login") armLogin(msg);
  });

  post({ kind: "hello", path: location.pathname });
})();
