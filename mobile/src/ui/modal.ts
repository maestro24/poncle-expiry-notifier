/**
 * Focus handling for the app's static sheets (업데이트, 문자 보내기, 온보딩 — audit
 * I13), matching the in-app dialog: opening moves focus into the sheet (so
 * TalkBack reads it, not the list behind), Tab stays inside while it is open, and
 * closing returns focus to whatever opened it — or, when that was re-rendered
 * away, to its nearest container still on the page. role="dialog" /
 * aria-modal / aria-labelledby live on the markup (index.html).
 */
import { ancestorsOf, returnFocus } from "./dialog";

interface OpenState {
  opener: HTMLElement | null;
  ancestors: HTMLElement[];
  onKey: (e: KeyboardEvent) => void;
}

const open = new WeakMap<HTMLElement, OpenState>();

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

function focusables(overlay: HTMLElement): HTMLElement[] {
  return Array.from(overlay.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((el) => !el.closest(".hidden") && !el.hasAttribute("hidden"));
}

/** Show `overlay` and focus `initial` (default: its first focusable element).
 *  Re-opening an already open sheet only moves the focus. */
export function openModal(overlay: HTMLElement, initial?: HTMLElement | null): void {
  if (!open.has(overlay)) {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const opener = active && !overlay.contains(active) ? active : null;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Tab" || overlay.classList.contains("hidden")) return;
      const list = focusables(overlay);
      if (!list.length) return;
      const i = list.indexOf(document.activeElement as HTMLElement);
      const outside = i < 0;
      const atEdge = e.shiftKey ? i <= 0 : i === list.length - 1;
      if (!outside && !atEdge) return; // let the browser move between inner elements
      e.preventDefault();
      list[e.shiftKey ? list.length - 1 : 0].focus();
    };
    document.addEventListener("keydown", onKey, true);
    open.set(overlay, { opener, ancestors: ancestorsOf(opener), onKey });
  }
  overlay.classList.remove("hidden");
  const target = initial ?? focusables(overlay)[0];
  target?.focus();
}

/** Hide `overlay` and give focus back to its opener. Safe when not open. */
export function closeModal(overlay: HTMLElement): void {
  overlay.classList.add("hidden");
  const st = open.get(overlay);
  if (!st) return;
  open.delete(overlay);
  document.removeEventListener("keydown", st.onKey, true);
  returnFocus(st.opener, st.ancestors);
}
