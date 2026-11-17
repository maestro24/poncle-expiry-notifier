/**
 * #47: keep modals (send sheet, in-app dialog) above the soft keyboard.
 *
 * Publishes the VISIBLE viewport as CSS variables --vvh (height) and --vv-top
 * (offset) from window.visualViewport, so .modal-overlay/.modal can size to what
 * the user actually sees even when the keyboard overlays the WebView instead of
 * resizing it (dvh does not shrink for the keyboard). Without visualViewport the
 * CSS falls back to 100dvh. The native side (MainActivity) additionally shrinks
 * the WebView by the IME inset on Android 15+ edge-to-edge.
 */
export function installViewportVars(win: Window): void {
  const vv = win.visualViewport;
  if (!vv) return;
  const style = win.document.documentElement.style;
  const apply = (): void => {
    style.setProperty("--vvh", `${Math.round(vv.height)}px`);
    style.setProperty("--vv-top", `${Math.round(vv.offsetTop)}px`);
  };
  apply();
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
}
