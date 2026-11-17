import { describe, expect, it } from "vitest";
import { installViewportVars } from "../src/ui/viewport";

type Listener = () => void;
function fakeWindow(vv: { height: number; offsetTop: number } | null) {
  const listeners: Record<string, Listener[]> = {};
  const props = new Map<string, string>();
  const visualViewport = vv && {
    ...vv,
    addEventListener: (t: string, l: Listener) => { (listeners[t] ??= []).push(l); },
  };
  const win = {
    visualViewport,
    document: { documentElement: { style: { setProperty: (k: string, v: string) => props.set(k, v) } } },
  };
  return { win, props, fire: (t: string) => (listeners[t] ?? []).forEach((l) => l()) };
}

describe("installViewportVars (#47: modal stays above the soft keyboard)", () => {
  it("publishes the visible height/top and follows resize + scroll", () => {
    const vv = { height: 800, offsetTop: 0 };
    const f = fakeWindow(vv);
    installViewportVars(f.win as unknown as Window);
    expect(f.props.get("--vvh")).toBe("800px");
    expect(f.props.get("--vv-top")).toBe("0px");
    f.win.visualViewport!.height = 420; // keyboard opened
    f.fire("resize");
    expect(f.props.get("--vvh")).toBe("420px");
    f.win.visualViewport!.offsetTop = 30;
    f.fire("scroll");
    expect(f.props.get("--vv-top")).toBe("30px");
  });

  it("is a no-op without visualViewport (CSS falls back to 100dvh)", () => {
    const f = fakeWindow(null);
    expect(() => installViewportVars(f.win as unknown as Window)).not.toThrow();
    expect(f.props.size).toBe(0);
  });
});
