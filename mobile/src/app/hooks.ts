/**
 * Cross-screen hooks (showScreen / rerenderCurrent / renderDashboard). Lower-level
 * screens call these instead of importing nav/dashboard, so the import graph has no
 * cycles; main.ts installs the real functions before boot() runs.
 */
import type { Screen } from "./state";

export interface AppHooks {
  showScreen(name: Screen): void;
  rerenderCurrent(): void;
  renderDashboard(): Promise<void>;
}

const unset = (name: string) => (): never => {
  throw new Error(`app hook not installed: ${name}`);
};

/** Late-bound cross-screen calls; main.ts installs the real ones before boot(). */
export const hooks: AppHooks = {
  showScreen: unset("showScreen"),
  rerenderCurrent: unset("rerenderCurrent"),
  renderDashboard: unset("renderDashboard"),
};

export function installHooks(h: AppHooks): void {
  Object.assign(hooks, h);
}
