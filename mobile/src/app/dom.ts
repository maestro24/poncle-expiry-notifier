/**
 * DOM + formatting helpers shared by every screen: $/$$, esc, local date/time
 * strings, the toast, switch/chip aria state and the shared '요금제' meta line.
 */
import { cleanPlan } from "../domain/plan";

export const $ = <T extends HTMLElement = HTMLElement>(s: string): T => document.querySelector(s) as T;
export const $$ = (s: string): HTMLElement[] => Array.from(document.querySelectorAll(s));

/* ---------- helpers ---------- */
export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
export function nowIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
export function nowShort(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- toast ---------- */
interface ToastOpts { err?: boolean; undo?: () => void }
let toastTimer: ReturnType<typeof setTimeout> | null = null;
/** An undo toast is on screen: plain toasts wait behind it (L28) instead of
 *  replacing it, so its 실행취소 stays reachable for its full time. */
let undoShowing = false;
const TOAST_QUEUE_MAX = 3;
let toastQueue: Array<{ msg: string; opts: ToastOpts }> = [];

export function toast(msg: string, opts: ToastOpts = {}): void {
  if (undoShowing && !opts.undo) {
    toastQueue = [...toastQueue, { msg, opts }].slice(-TOAST_QUEUE_MAX);
    return;
  }
  showToast(msg, opts);
}

function showToast(msg: string, opts: ToastOpts): void {
  const el = $("#toast");
  if (!el) return;
  el.className = "toast" + (opts.err ? " err" : "");
  // Screen readers: errors interrupt (alert), everything else is a polite status.
  el.setAttribute("role", opts.err ? "alert" : "status");
  el.setAttribute("aria-live", opts.err ? "assertive" : "polite");
  el.textContent = msg;
  undoShowing = !!opts.undo;
  if (opts.undo) {
    const u = document.createElement("button");
    u.type = "button";
    u.className = "toast-undo";
    u.textContent = "실행취소";
    u.onclick = () => { hideToast(); opts.undo!(); };
    el.appendChild(u);
  }
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, opts.undo ? 6000 : 2600);
}

/** Hide the toast on screen, then show the next one that waited behind an undo. */
function hideToast(): void {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  undoShowing = false;
  const [next, ...rest] = toastQueue;
  toastQueue = rest;
  if (next) { showToast(next.msg, next.opts); return; }
  $("#toast")?.classList.add("hidden");
}

/** A "요금제 …" meta line (with a leading <br>), empty when the plan is blank.
 *  Shared by the home due list and the 이력 cards. Light display cleanup only. */
export function planLine(plan: string): string {
  const p = cleanPlan(plan);
  return p ? `<br>요금제 ${esc(p)}` : "";
}

export function todayIsoLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** Whole-day difference todayIso - expiryIso (UTC math, tz-safe). */
export function daysSince(expiryIso: string, todayIso: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, (m || 1) - 1, d || 1);
  };
  return Math.round((ms(todayIso) - ms(expiryIso)) / 86400000);
}

/** A role=switch toggle: visual state + aria-checked together (#62). */
export function setSwitch(el: HTMLElement, on: boolean): void {
  el.classList.toggle("on", on);
  el.setAttribute("aria-checked", on ? "true" : "false");
}
/** A chip that toggles: visual state + aria-pressed together (#62). */
export function setPressed(el: HTMLElement, on: boolean): void {
  el.classList.toggle("on", on);
  el.setAttribute("aria-pressed", on ? "true" : "false");
}
