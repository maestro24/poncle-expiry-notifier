/**
 * Where the send history is stored (L43, contract K1). Capacitor Preferences
 * writes with SharedPreferences.apply() — an app killed right after the 발송 toast
 * can lose the record and send twice later. The native layer offers a durable KV
 * (commit(), fsync-backed) that also migrates the old Preferences copy on first
 * read; only the send log goes there, every other key stays on Preferences.
 */
import type { KV } from "../domain/history";

/** History keys written to the durable store when it exists. */
export const DURABLE_HISTORY_KEYS: readonly string[] = ["sent_log"];

/** A KV that routes `keys` to `durable` (when given) and everything else to `base`. */
export function routeHistoryKV(base: KV, durable: KV | null | undefined, keys: readonly string[] = DURABLE_HISTORY_KEYS): KV {
  if (!durable) return base;
  const pick = (key: string): KV => (keys.includes(key) ? durable : base);
  return {
    get: (key) => pick(key).get(key),
    set: (key, value) => pick(key).set(key, value),
  };
}

function isKV(v: unknown): v is KV {
  const o = v as Partial<KV> | null;
  return !!o && typeof o.get === "function" && typeof o.set === "function";
}

/** The adapter module's durableKV() store, or null when this build has none (web,
 *  an older adapter, a test mock without it). Never throws. */
export function resolveDurableKV(adapters: unknown): KV | null {
  try {
    const factory = (adapters as { durableKV?: unknown } | null)?.durableKV;
    if (typeof factory !== "function") return null;
    const kv: unknown = (factory as () => unknown)();
    return isKV(kv) ? kv : null;
  } catch {
    return null;
  }
}
