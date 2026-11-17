/**
 * In-app confirm / alert dialog — replaces the native window.confirm / alert /
 * prompt (Android WebView shows those as a bare system box with the page origin as
 * the title). Uses the app's own .modal-overlay sheet, Korean buttons (취소 / 확인),
 * resolves a Promise, and is focus-safe: focus moves into the dialog (취소 first
 * for a confirm, so a stray Enter never confirms), Tab is trapped between the two
 * buttons, Escape / a backdrop tap = 취소, and focus returns to the opener on close.
 * Dialogs requested while one is open are queued and shown one at a time.
 */

export interface DialogOptions {
  /** Bold heading; defaults to "확인" (confirm) / "알림" (alert). */
  title?: string;
  /** Primary button label (default "확인"). */
  okLabel?: string;
  /** Secondary button label for a confirm (default "취소"). */
  cancelLabel?: string;
  /** Destructive action: the primary button is shown in red. */
  danger?: boolean;
}

const ID = "app-dialog";
let queue: Promise<unknown> = Promise.resolve();
let openNow = false;
/** Settles the dialog on screen as a dismiss (취소 / 뒤로); null when none is open. */
let dismissOpen: (() => void) | null = null;

interface DialogEls {
  overlay: HTMLElement;
  title: HTMLElement;
  msg: HTMLElement;
  ok: HTMLButtonElement;
  cancel: HTMLButtonElement;
}

/** Find (or lazily build) the dialog DOM. Built on demand so it works on any page
 *  state (the e2e suite and the app both re-render the body). */
function ensureDialog(): DialogEls {
  let overlay = document.getElementById(ID);
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = ID;
    overlay.className = "modal-overlay app-dialog hidden";
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", `${ID}-title`);
    overlay.setAttribute("aria-describedby", `${ID}-msg`);
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title" id="${ID}-title"></div>
        <div class="app-dialog-msg" id="${ID}-msg"></div>
        <div class="modal-actions">
          <button type="button" class="btn-soft" id="${ID}-cancel">취소</button>
          <button type="button" class="btn-dark" id="${ID}-ok">확인</button>
        </div>
      </div>`;
    (document.getElementById("app") ?? document.body).appendChild(overlay);
  }
  return {
    overlay,
    title: overlay.querySelector(`#${ID}-title`) as HTMLElement,
    msg: overlay.querySelector(`#${ID}-msg`) as HTMLElement,
    ok: overlay.querySelector(`#${ID}-ok`) as HTMLButtonElement,
    cancel: overlay.querySelector(`#${ID}-cancel`) as HTMLButtonElement,
  };
}

/** The opener's ancestors (nearest first, below <body>), recorded when the dialog
 *  opens: the opener itself may be re-rendered away while the dialog is up. */
export function ancestorsOf(el: HTMLElement | null): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let p = el?.parentElement ?? null; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    out.push(p);
  }
  return out;
}

/** Focus back to the opener, or — when it was removed (a list redraw replaced its
 *  card) — to its nearest ancestor still on the page (e.g. #due-list), so screen
 *  readers don't land on <body> (L30). */
export function returnFocus(opener: HTMLElement | null, ancestors: HTMLElement[]): void {
  if (opener && document.contains(opener)) { opener.focus(); return; }
  const target = ancestors.find((a) => document.contains(a));
  if (!target) return;
  if (target.tabIndex < 0 && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus();
}

function show(message: string, opts: DialogOptions, isConfirm: boolean): Promise<boolean> {
  const els = ensureDialog();
  const { overlay, title, msg, ok, cancel } = els;
  title.textContent = opts.title ?? (isConfirm ? "확인" : "알림");
  msg.textContent = message; // textContent: never HTML; CSS keeps the line breaks
  ok.textContent = opts.okLabel ?? "확인";
  cancel.textContent = opts.cancelLabel ?? "취소";
  cancel.classList.toggle("hidden", !isConfirm);
  ok.classList.toggle("danger", !!opts.danger);
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const openerAncestors = ancestorsOf(opener);
  overlay.classList.remove("hidden");
  openNow = true;

  return new Promise<boolean>((resolve) => {
    const buttons = (): HTMLButtonElement[] => (isConfirm ? [cancel, ok] : [ok]);
    const finish = (value: boolean): void => {
      document.removeEventListener("keydown", onKey, true);
      overlay.onclick = null;
      ok.onclick = null;
      cancel.onclick = null;
      overlay.classList.add("hidden");
      openNow = false;
      dismissOpen = null;
      returnFocus(opener, openerAncestors);
      resolve(value);
    };
    const dismissValue = !isConfirm; // alert: dismiss == acknowledge
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(dismissValue);
      } else if (e.key === "Tab") {
        e.preventDefault();
        const list = buttons();
        const i = list.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i + 1) % list.length;
        list[next].focus();
      }
    }
    document.addEventListener("keydown", onKey, true);
    dismissOpen = () => finish(dismissValue);
    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    overlay.onclick = (e) => { if (e.target === overlay) finish(dismissValue); };
    (isConfirm ? cancel : ok).focus();
  });
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/** In-app replacement for window.confirm: true = 확인, false = 취소/뒤로. */
export function appConfirm(message: string, opts: DialogOptions = {}): Promise<boolean> {
  return enqueue(() => show(message, opts, true));
}

/** In-app replacement for window.alert: resolves once 확인 is pressed. */
export function appAlert(message: string, opts: DialogOptions = {}): Promise<void> {
  return enqueue(() => show(message, opts, false)).then(() => undefined);
}

/** Whether an in-app dialog is on screen (e.g. to hold an auto popup). */
export function isAppDialogOpen(): boolean {
  return openNow;
}

/**
 * Android hardware back while a dialog is up: dismiss it like 취소 (a confirm
 * resolves false, an alert resolves) — the same as the native confirm it replaced.
 * Returns true when a dialog was dismissed (the back press is consumed).
 */
export function dismissAppDialog(): boolean {
  if (!dismissOpen) return false;
  dismissOpen();
  return true;
}
