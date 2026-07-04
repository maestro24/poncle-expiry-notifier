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
  channel: string;
  sent_at: string; // ISO local datetime
}

/** Minimal persistent key/value backend (Preferences in the app). */
export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

const KEY = "sent_log";

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
