/**
 * Local send history + dedup. Replaces backend/db.py's sent_log. Stored as a
 * JSON array via an injected key/value backend (Capacitor Preferences in the app,
 * an in-memory map in tests). Dedup key: (phone, expiry_date, milestone_offset),
 * so each customer is alerted at most once per milestone.
 *
 * The volume is a single store's daily sends, so a JSON blob in Preferences is
 * adequate; if it ever outgrows that, swap the backend for capacitor-sqlite
 * without touching callers.
 */
import { Preferences } from "@capacitor/preferences";
import type { DueItem } from "./types";

export interface SentRecord {
  phone: string;
  customer: string;
  opendate: string;
  expiry_date: string;
  milestone_offset: number;
  telecom: string;
  agency: string;
  plan: string;
  model: string;
  openhow: string;
  staff: string;
  channel: string; // "sms" | "record-only" | "skipped"
  sent_at: string; // ISO local datetime
  body?: string; // the actual message text sent (empty for skips)
}

/** Minimal persistent key/value backend (Preferences in the app). */
export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

const KEY = "sent_log";
/** phone|expiry keys the staff manually EXCLUDED (제외) from the 미방문 list.
 *  Real returns auto-clear via a new 개통; this override is only for cases Poncle
 *  won't reflect. (Key kept as "unvisited_handled" to preserve v1.2.1 data.) */
const HANDLED_KEY = "unvisited_handled";
/** Last scan's derived 미방문 list, so the 이력 screen shows it without re-scanning. */
const CACHE_KEY = "unvisited_cache";
/** One-shot guard so the v1.1.x 연락완료 -> handled migration runs only once. */
const MIGRATED_KEY = "unvisited_handled_migrated";

// Dedup identifies a customer's contract by phone + expiry date. Offset (days
// until expiry) is deliberately NOT part of the key: in the range scan model it
// changes daily, and a customer should be contacted once per contract, not once
// per day-until-expiry.
function dedupKey(phone: string, expiry: string): string {
  return `${phone}|${expiry}`;
}

export class History {
  // Serializes mutations so concurrent recordSent calls can't interleave their
  // read-modify-write over the whole JSON blob (double-record / lost-write race).
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private kv: KV) {}

  private async all(): Promise<SentRecord[]> {
    const raw = await this.kv.get(KEY);
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? (arr as SentRecord[]) : [];
    } catch {
      return [];
    }
  }

  private async writeAll(rows: SentRecord[]): Promise<void> {
    await this.kv.set(KEY, JSON.stringify(rows));
  }

  async alreadySent(phone: string, expiry: string): Promise<boolean> {
    const key = dedupKey(phone, expiry);
    const rows = await this.all();
    return rows.some((r) => dedupKey(r.phone, r.expiry_date) === key);
  }

  /** All sent dedup keys ("phone|expiry") as a Set, for O(1) membership during a
   *  scan (avoids re-parsing the whole store once per due row). */
  async dedupKeySet(): Promise<Set<string>> {
    const rows = await this.all();
    return new Set(rows.map((r) => dedupKey(r.phone, r.expiry_date)));
  }

  /** Insert (dedup). Returns true if newly inserted, false if already present.
   *  Serialized against other recordSent calls so the read-modify-write is atomic. */
  async recordSent(entry: Omit<SentRecord, "channel" | "sent_at">, channel: string, nowIso: string): Promise<boolean> {
    const task = this.lock.then(async () => {
      const rows = await this.all();
      const key = dedupKey(entry.phone, entry.expiry_date);
      if (rows.some((r) => dedupKey(r.phone, r.expiry_date) === key)) {
        return false;
      }
      rows.push({ ...entry, channel, sent_at: nowIso });
      await this.writeAll(rows);
      return true;
    });
    this.lock = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** All stored records (for backup/export). */
  async exportAll(): Promise<SentRecord[]> {
    return this.all();
  }

  /** Replace the entire store (for restore from a backup). Serialized. */
  async replaceAll(rows: SentRecord[]): Promise<void> {
    const task = this.lock.then(() => this.writeAll(Array.isArray(rows) ? rows : []));
    this.lock = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** Remove the record(s) for a dedup key (used to undo a skip). Serialized. */
  async remove(phone: string, expiry: string): Promise<void> {
    const key = dedupKey(phone, expiry);
    const task = this.lock.then(async () => {
      const rows = (await this.all()).filter((r) => dedupKey(r.phone, r.expiry_date) !== key);
      await this.writeAll(rows);
    });
    this.lock = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** Cache the last scan's derived 미방문 list (full overwrite). Serialized. */
  async cacheUnvisited(rows: DueItem[]): Promise<void> {
    const task = this.lock.then(() =>
      this.kv.set(CACHE_KEY, JSON.stringify(Array.isArray(rows) ? rows : [])),
    );
    this.lock = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** Read the cached 미방문 list from the last scan (empty until first scan). */
  async loadUnvisited(): Promise<DueItem[]> {
    const raw = await this.kv.get(CACHE_KEY);
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? (arr as DueItem[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * One-time upgrade from v1.1.x: fold the retired `recontacted` flag (the old
   * 연락완료 dismissal on sent_log rows) into the new handled set, so customers a
   * user already marked handled don't re-surface in the 미방문 list. Idempotent.
   */
  async migrateRecontacted(): Promise<void> {
    if (await this.kv.get(MIGRATED_KEY)) return;
    const task = this.lock.then(async () => {
      const rows = (await this.all()) as Array<SentRecord & { recontacted?: boolean }>;
      const legacy = rows.filter((r) => r.recontacted === true);
      if (legacy.length) {
        const keys = await this.handledKeys();
        for (const r of legacy) keys.add(dedupKey(r.phone, r.expiry_date));
        await this.kv.set(HANDLED_KEY, JSON.stringify(Array.from(keys)));
      }
      await this.kv.set(MIGRATED_KEY, "1");
    });
    this.lock = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** phone|expiry keys the staff manually 제외(excluded) from the 미방문 list. */
  async handledKeys(): Promise<Set<string>> {
    const raw = await this.kv.get(HANDLED_KEY);
    if (!raw) return new Set();
    try {
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? (arr as string[]) : []);
    } catch {
      return new Set();
    }
  }

  /** Toggle the manual 제외(exclude) flag for a customer (phone|expiry). Serialized. */
  async setHandled(phone: string, expiry: string, val: boolean): Promise<void> {
    const key = dedupKey(phone, expiry);
    const task = this.lock.then(async () => {
      const keys = await this.handledKeys();
      if (val) keys.add(key);
      else keys.delete(key);
      await this.kv.set(HANDLED_KEY, JSON.stringify(Array.from(keys)));
    });
    this.lock = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** History screen: successful sends, newest first, optional text/date filter.
   *  `query` matches customer or phone; start/end are inclusive ISO dates. */
  async search(query = "", start = "", end = "", limit = 1000): Promise<SentRecord[]> {
    const q = query.trim().toLowerCase();
    let rows = await this.all();
    if (q) {
      rows = rows.filter(
        (r) => r.customer.toLowerCase().includes(q) || r.phone.toLowerCase().includes(q),
      );
    }
    if (start) rows = rows.filter((r) => r.sent_at.slice(0, 10) >= start);
    if (end) rows = rows.filter((r) => r.sent_at.slice(0, 10) <= end);
    rows = rows.slice().sort((a, b) => (a.sent_at < b.sent_at ? 1 : a.sent_at > b.sent_at ? -1 : 0));
    return rows.slice(0, limit);
  }
}

/** Capacitor Preferences-backed KV for the app. */
export function preferencesKV(): KV {
  return {
    async get(key: string): Promise<string | null> {
      const { value } = await Preferences.get({ key });
      return value ?? null;
    },
    async set(key: string, value: string): Promise<void> {
      await Preferences.set({ key, value });
    },
  };
}
