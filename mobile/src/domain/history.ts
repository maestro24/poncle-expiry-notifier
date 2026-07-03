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

function dedupKey(phone: string, expiry: string, offset: number): string {
  return `${phone}|${expiry}|${offset}`;
}

export class History {
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

  async alreadySent(phone: string, expiry: string, offset: number): Promise<boolean> {
    const key = dedupKey(phone, expiry, offset);
    const rows = await this.all();
    return rows.some((r) => dedupKey(r.phone, r.expiry_date, r.milestone_offset) === key);
  }

  /** Insert (dedup). Returns true if newly inserted, false if already present. */
  async recordSent(entry: Omit<SentRecord, "channel" | "sent_at">, channel: string, nowIso: string): Promise<boolean> {
    const rows = await this.all();
    const key = dedupKey(entry.phone, entry.expiry_date, entry.milestone_offset);
    if (rows.some((r) => dedupKey(r.phone, r.expiry_date, r.milestone_offset) === key)) {
      return false;
    }
    rows.push({ ...entry, channel, sent_at: nowIso });
    await this.writeAll(rows);
    return true;
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
