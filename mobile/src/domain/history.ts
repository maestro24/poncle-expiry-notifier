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
import { correctCohortInformed, type CohortEntry } from "./cohort";
import { decodeDueItemText } from "./due-item";
import {
  EXCLUSION_CONTRACT_PREFIX,
  ExclusionIndex,
  exclusionContractKey,
  normalizeExclusionKey,
  type ExclusionTarget,
} from "./exclusions";
import { mergeHistory, type MergeRestoreResult } from "./history-merge";
import { HISTORY_PAGE_SIZE, filterHistory, type HistoryPage, type HistoryPageQuery } from "./history-search";
import { decodeSentRecordText, utf8ByteLength } from "./history-text";
import { dueKey, normalizePhone } from "./keepdate";
import { applySendResultsToRows, type ApplyResultsOutcome, type SmsSendResult } from "./send-results-apply";
import { SentIndex, type StageConfig } from "./sent-index";
import { carrySendStats, countsAsHandled, countsAsSent, isManualRecord, recordKey, type SentRecord } from "./sent-record";
import type { DueItem, RecordSource, SentMatchTarget } from "./types";

// Re-exports: the split-out modules stay importable from "./history".
export {
  countsAsSent,
  isManualRecord,
  recordKey,
  sanitizePrevSend,
  sanitizeSendStats,
  sendStats,
  sendSummaryLabel,
  sentStateOf,
  withResendBackup,
  type PrevSend,
  type SendStats,
  type SentRecord,
} from "./sent-record";
export { decodeSentRecordText, SENT_LOG_WARN_BYTES, sentLogSizeWarning, utf8ByteLength } from "./history-text";
export { inferSource, SentIndex, type StageConfig } from "./sent-index";
export { parseSendResults, type ApplyResultsOutcome, type SmsSendResult } from "./send-results-apply";
export { mergeHistory, type MergeRestoreResult } from "./history-merge";
export { HISTORY_PAGE_SIZE, isPhoneQuery, type HistoryPage, type HistoryPageQuery } from "./history-search";

export { EXCLUSION_CONTRACT_PREFIX, ExclusionIndex, exclusionContractKey, normalizeExclusionKey, type ExclusionTarget };

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
/** One-shot guard for the B8 upgrade: legacy phone|expiry 제외 keys gain the
 *  contract key ("open:<phone>|<opendate>") of their unvisited_cache row. */
const EXCLUSION_CONTRACT_MIGRATED_KEY = "unvisited_handled_contract_migrated";
/** Last scan's due list, so the 대시보드 shows counts/임박/통신사 without re-scanning. */
const DUELIST_KEY = "due_cache";
/** ISO date (yyyy-mm-dd) of the scan that produced due_cache ("" = unknown/old cache). */
const DUELIST_DATE_KEY = "due_cache_date";
/** ISO date of the last successful scan whose 미결 fetch was NOT degraded — the
 *  catch-up anchor (see catchUpAnchor). Absent before v1.2.17. */
const CLEAN_SCAN_DATE_KEY = "last_clean_scan_date";
/** ISO datetime of the last data backup, for the 대시보드 backup reminder. */
const BACKUP_KEY = "last_backup_at";
/** Display timestamp of the last scan (survives app restart for the 대시보드). */
const LASTSCAN_KEY = "last_scan_at";
/** 재방문 전환율 cohort log (expired customers + informed/revisited flags). */
const COHORT_KEY = "cohort_log";
/** One-shot guard for the cohort informed correction. v2 (stage 3): informed must be
 *  backed by a REAL send (not record-only, not a skip, not failed) — re-runs once
 *  even where the v1 (record-only only) correction already ran. */
const COHORT_INFORMED_MIGRATED_KEY = "cohort_informed_migrated_v2";

function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? (a as T[]) : [];
  } catch {
    return [];
  }
}

// Dedup identifies a customer's contract by phone + expiry date. Offset (days
// until expiry) is deliberately NOT part of the key: in the range scan model it
// changes daily, and a customer should be contacted once per contract, not once
// per day-until-expiry. Phone is normalized (dueKey) so hyphenated vs bare formats
// from different Poncle endpoints collapse to one key.
function dedupKey(phone: string, expiry: string): string {
  return dueKey(phone, expiry);
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
      if (!Array.isArray(arr)) return [];
      // Decode entities an older version stored ("PS&amp;M", audit D1); the next
      // write persists the clean text. Idempotent on clean records.
      return (arr as unknown[])
        .filter((r): r is SentRecord => typeof r === "object" && r !== null)
        .map(decodeSentRecordText);
    } catch {
      return [];
    }
  }

  /** UTF-8 size of the stored send log (I12): the whole log is ONE Preferences value
   *  re-written on every send, so the 설정 screen warns past SENT_LOG_WARN_BYTES. */
  async storageBytes(): Promise<number> {
    return utf8ByteLength((await this.kv.get(KEY)) ?? "");
  }

  private async writeAll(rows: SentRecord[]): Promise<void> {
    await this.kv.set(KEY, JSON.stringify(rows));
  }

  /** Serialize a read-modify-write task against all other mutations. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.lock.then(fn);
    this.lock = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** True when (phone, expiry) is already handled (real send or manual skip).
   *  Practice (record-only) and failed sends do NOT count. */
  async alreadySent(phone: string, expiry: string): Promise<boolean> {
    const key = dedupKey(phone, expiry);
    const rows = await this.all();
    return rows.some((r) => recordKey(r) === key && countsAsHandled(r));
  }

  /** Handled dedup keys ("phone|expiry") as a Set, for O(1) membership during a
   *  scan (avoids re-parsing the whole store once per due row). Only a real,
   *  not-failed SMS or a manual skip counts — record-only (practice) and failed
   *  sends stay sendable everywhere (home, 미방문, cohort). */
  async dedupKeySet(): Promise<Set<string>> {
    const rows = await this.all();
    return new Set(rows.filter((r) => !isManualRecord(r) && countsAsHandled(r)).map((r) => dedupKey(r.phone, r.expiry_date)));
  }

  /** A SentIndex snapshot of the log: exact key + same-contract fallback matching.
   *  Prefer this over recordsByKey/dedupKeySet for any already-sent decision. */
  async sentIndex(cfg: StageConfig = {}): Promise<SentIndex> {
    return new SentIndex(await this.all(), cfg);
  }

  /** The record deciding this customer's send state (exact phone|expiry, else the
   *  same contract+stage), or null — for the confirm sheet's '이미 발송됨' and 재발송. */
  async findRecord(t: SentMatchTarget, cfg: StageConfig = {}): Promise<SentRecord | null> {
    return (await this.sentIndex(cfg)).recordFor(t) ?? null;
  }

  /** The stored record per normalized key (last one wins), for state badges. */
  async recordsByKey(): Promise<Map<string, SentRecord>> {
    const map = new Map<string, SentRecord>();
    for (const r of await this.all()) if (!isManualRecord(r)) map.set(dedupKey(r.phone, r.expiry_date), r);
    return map;
  }

  /** Insert (dedup). Returns true if newly inserted, false if already handled. A
   *  non-handled record (practice/failed) for the same key is replaced.
   *  Serialized against other recordSent calls so the read-modify-write is atomic. */
  async recordSent(entry: Omit<SentRecord, "channel" | "sent_at">, channel: string, nowIso: string): Promise<boolean> {
    return this.serialize(async () => {
      const all = await this.all();
      const key = recordKey(entry);
      const same = (r: SentRecord) => recordKey(r) === key;
      if (all.some((r) => same(r) && countsAsHandled(r))) {
        return false;
      }
      const rows = all.filter((r) => !same(r));
      rows.push({ ...entry, channel, sent_at: nowIso });
      await this.writeAll(rows);
      return true;
    });
  }

  /** All stored records (for backup/export). */
  async exportAll(): Promise<SentRecord[]> {
    return this.all();
  }

  /**
   * Restore a backup's records by MERGING them into the log as it is NOW (audit B6):
   * the latest log is re-read inside the history lock, so a failure result or a
   * 재발송 recorded while a restore prompt was open is never overwritten by a stale
   * snapshot. Same rules as mergeHistory. Serialized.
   */
  async mergeRestore(incoming: SentRecord[]): Promise<MergeRestoreResult> {
    const list = Array.isArray(incoming) ? incoming : [];
    return this.serialize(async () => {
      const current = await this.all();
      const merged = mergeHistory(current, list);
      const have = new Set(current.map(recordKey));
      const added = merged.filter((r) => !have.has(recordKey(r))).length;
      await this.writeAll(merged);
      return { added, kept: merged.length - added };
    });
  }

  /** Replace the entire store (for restore from a backup). Serialized. */
  async replaceAll(rows: SentRecord[]): Promise<void> {
    return this.serialize(() => this.writeAll(Array.isArray(rows) ? rows : []));
  }

  /** Remove the milestone record(s) for a dedup key (used to undo a skip). A manual
   *  send of the same key is kept. Serialized. */
  async remove(phone: string, expiry: string): Promise<void> {
    const key = dedupKey(phone, expiry);
    return this.serialize(async () => {
      const rows = (await this.all()).filter((r) => recordKey(r) !== key);
      await this.writeAll(rows);
    });
  }

  /** The stored MILESTONE record for (phone, expiry), or null. Pass source "manual"
   *  for the manual-send record of that key instead (a manual send's prev / state). */
  async getRecord(phone: string, expiry: string, source?: RecordSource): Promise<SentRecord | null> {
    const key = recordKey({ phone, expiry_date: expiry, source });
    const rows = await this.all();
    return rows.find((r) => recordKey(r) === key) ?? null;
  }

  /** Replace-or-insert a full record by (phone, expiry) — an upsert used by 재발송
   *  (send again to an already-alerted customer, updating the existing 안내 이력).
   *  A practice (record-only) record never replaces a real SMS record: the sms
   *  channel/sent_at/body are the only evidence of the actual send (audit 1-12).
   *  Replacing a stored record carries its first_sent_at/send_count forward (a new
   *  SMS adds one send; a skip keeps the count) — audit 3-15.
   *  Resolves true when written, false when kept as-is. Serialized. */
  async putRecord(rec: SentRecord): Promise<boolean> {
    const key = recordKey(rec); // a manual send and a milestone send never replace each other
    return this.serialize(async () => {
      const all = await this.all();
      const same = all.filter((r) => recordKey(r) === key);
      if (rec.channel === "record-only" && same.some((r) => r.channel === "sms")) return false;
      const rows = all.filter((r) => recordKey(r) !== key);
      const prev = same[same.length - 1];
      rows.push(prev ? carrySendStats(rec, prev) : rec);
      await this.writeAll(rows);
      return true;
    });
  }

  /**
   * Apply async native send results to the records whose `sms_id` matches: "fail"
   * marks the record failed (no longer counts as sent anywhere), "ok" marks it
   * delivered. A result for an EARLIER send kept in a 재발송's prev_sent chain is
   * matched too (audit B5): a failed earlier send leaves the chain and its count; an
   * ok one is marked delivered there. Results for ids no record carries (test sends)
   * are reported as unmatched and change nothing. Idempotent, so a crash before the
   * caller acks just re-applies the same outcome. Serialized.
   */
  async applySendResults(results: SmsSendResult[]): Promise<ApplyResultsOutcome> {
    if (!results.length) return { failed: [], resendFailed: [], delivered: 0, unmatched: [] };
    return this.serialize(async () => {
      const rows = await this.all();
      const { next, changed, outcome } = applySendResultsToRows(rows, results);
      if (changed) await this.writeAll(next);
      return outcome;
    });
  }

  /** Cache the last scan's derived 미방문 list (full overwrite). Serialized. */
  async cacheUnvisited(rows: DueItem[]): Promise<void> {
    return this.serialize(() => this.kv.set(CACHE_KEY, JSON.stringify(Array.isArray(rows) ? rows : [])));
  }

  /** Read the cached 미방문 list from the last scan (empty until first scan). */
  async loadUnvisited(): Promise<DueItem[]> {
    // Decode entities a pre-v1.2.17 cache may still hold (idempotent on clean rows).
    return parseJsonArray<DueItem>(await this.kv.get(CACHE_KEY)).map(decodeDueItemText);
  }

  /** Cache the last scan's due list (for the 대시보드 counts + boot restore). Test
   *  rows are never persisted. `scanDateIso` (yyyy-mm-dd) is stored only when a
   *  fresh scan produced the list; re-caches after a send keep the original date.
   *  Serialized. */
  async cacheDueList(rows: DueItem[], scanDateIso?: string): Promise<void> {
    const real = (Array.isArray(rows) ? rows : []).filter((r) => !r.test);
    return this.serialize(async () => {
      await this.kv.set(DUELIST_KEY, JSON.stringify(real));
      if (scanDateIso) await this.kv.set(DUELIST_DATE_KEY, scanDateIso);
    });
  }

  /** Read the cached due list from the last scan (empty until first scan). */
  async loadDueList(): Promise<DueItem[]> {
    const isReal = (r: DueItem): boolean => typeof r === "object" && r !== null && !r.test;
    const raw = parseJsonArray<DueItem>(await this.kv.get(DUELIST_KEY));
    const real = raw.filter(isReal);
    if (real.length !== raw.length) {
      // A v1.2.16 cache may still hold the injected test row (010-1234-5678): never
      // restore it (it would be sendable as a real customer — audit B3) and drop it
      // from storage once, re-reading inside the lock so a newer cache isn't clobbered.
      await this.serialize(async () => {
        const latest = parseJsonArray<DueItem>(await this.kv.get(DUELIST_KEY));
        const clean = latest.filter(isReal);
        if (clean.length !== latest.length) await this.kv.set(DUELIST_KEY, JSON.stringify(clean));
      });
    }
    // Decode entities a pre-v1.2.17 cache may still hold (idempotent on clean rows).
    return real.map(decodeDueItemText);
  }

  /** ISO date of the scan behind the cached due list; "" if unknown (pre-upgrade cache). */
  async getDueCacheDate(): Promise<string> {
    return (await this.kv.get(DUELIST_DATE_KEY)) ?? "";
  }

  /** ISO date of the last non-degraded successful scan; "" if never recorded. */
  async getCleanScanDate(): Promise<string> {
    return (await this.kv.get(CLEAN_SCAN_DATE_KEY)) ?? "";
  }

  /** Record a non-degraded successful scan's day (the catch-up anchor). */
  async setCleanScanDate(isoDate: string): Promise<void> {
    await this.kv.set(CLEAN_SCAN_DATE_KEY, isoDate);
  }

  /** Record when the user last exported/backed up (ISO datetime). */
  async setLastBackup(nowIso: string): Promise<void> {
    await this.kv.set(BACKUP_KEY, nowIso);
  }

  /** ISO datetime of the last backup, "" if never. */
  async getLastBackup(): Promise<string> {
    return (await this.kv.get(BACKUP_KEY)) ?? "";
  }

  /** Persist the last scan's display timestamp (so the 대시보드 survives restart). */
  async setLastScan(label: string): Promise<void> {
    await this.kv.set(LASTSCAN_KEY, label);
  }

  /** Last scan's display timestamp, "" if never scanned. */
  async getLastScan(): Promise<string> {
    return (await this.kv.get(LASTSCAN_KEY)) ?? "";
  }

  /** Read the 재방문 전환율 cohort log. */
  async loadCohort(): Promise<CohortEntry[]> {
    return parseJsonArray<CohortEntry>(await this.kv.get(COHORT_KEY));
  }

  /** Persist the cohort log (full overwrite). Serialized. */
  async saveCohort(entries: CohortEntry[]): Promise<void> {
    return this.serialize(() => this.kv.set(COHORT_KEY, JSON.stringify(Array.isArray(entries) ? entries : [])));
  }

  /**
   * One-time fix for cohort entries stored informed=true before record-only
   * (practice) records stopped counting as sent: keep `informed` only where a handled
   * record (real send or skip) exists for phone|expiry. Idempotent via a flag, so a
   * later genuine informed=true is never touched. Resolves the number corrected.
   */
  async migrateCohortInformed(): Promise<number> {
    if (await this.kv.get(COHORT_INFORMED_MIGRATED_KEY)) return 0;
    return this.serialize(async () => {
      const prev = parseJsonArray<CohortEntry>(await this.kv.get(COHORT_KEY));
      const realSent = new Set(
        (await this.all()).filter((r) => countsAsSent(r) && !isManualRecord(r)).map((r) => dedupKey(r.phone, r.expiry_date)),
      );
      const next = correctCohortInformed(prev, realSent);
      const fixed = next.filter((e, i) => e.informed !== prev[i].informed).length;
      if (fixed) await this.kv.set(COHORT_KEY, JSON.stringify(next));
      await this.kv.set(COHORT_INFORMED_MIGRATED_KEY, "1");
      return fixed;
    });
  }

  /**
   * One-time upgrade from v1.1.x: fold the retired `recontacted` flag (the old
   * 연락완료 dismissal on sent_log rows) into the new handled set, so customers a
   * user already marked handled don't re-surface in the 미방문 list. Idempotent.
   */
  async migrateRecontacted(): Promise<void> {
    if (await this.kv.get(MIGRATED_KEY)) return;
    return this.serialize(async () => {
      const rows = (await this.all()) as Array<SentRecord & { recontacted?: boolean }>;
      const legacy = rows.filter((r) => r.recontacted === true);
      if (legacy.length) {
        const keys = await this.handledKeys();
        for (const r of legacy) keys.add(dedupKey(r.phone, r.expiry_date));
        await this.kv.set(HANDLED_KEY, JSON.stringify(Array.from(keys)));
      }
      await this.kv.set(MIGRATED_KEY, "1");
    });
  }

  /**
   * One-time upgrade (audit B8) for 제외 saved before contract keys existed: each
   * legacy phone|expiry key whose row is in the cached 미방문 list (same dueKey — the
   * cache was built with the same 개월 settings as the key) gains that row's contract
   * key, so a later 약정/기본 개월 change keeps the customer excluded. Legacy keys are
   * kept; keys without a cached row stay exact-only. Flag-guarded (a later
   * un-exclude is never undone). Serialized; resolves how many keys were upgraded.
   */
  async migrateLegacyExclusions(): Promise<number> {
    if (await this.kv.get(EXCLUSION_CONTRACT_MIGRATED_KEY)) return 0;
    return this.serialize(async () => {
      const keys = await this.handledKeys();
      const legacy = new Set(
        Array.from(keys)
          .filter((k) => !k.startsWith(EXCLUSION_CONTRACT_PREFIX))
          .map((k) => normalizeExclusionKey(k))
          .filter((k): k is string => !!k),
      );
      let added = 0;
      if (legacy.size) {
        for (const row of parseJsonArray<DueItem>(await this.kv.get(CACHE_KEY))) {
          if (!row || !legacy.has(dueKey(row.phone, row.expiry_date))) continue;
          const ck = exclusionContractKey(row.phone, row.opendate);
          if (ck && !keys.has(ck)) {
            keys.add(ck);
            added++;
          }
        }
        if (added) await this.kv.set(HANDLED_KEY, JSON.stringify(Array.from(keys)));
      }
      await this.kv.set(EXCLUSION_CONTRACT_MIGRATED_KEY, "1");
      return added;
    });
  }

  /** Keys the staff manually 제외(excluded) from the 미방문 list: phone|expiry and,
   *  since R1, contract keys "open:<phone>|<opendate>" (see ExclusionIndex). Carried
   *  as-is by a backup; prefer exclusionIndex()/isHandled() for matching. */
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

  /** Snapshot matcher over the manual 제외 set (exact key OR same contract). */
  async exclusionIndex(): Promise<ExclusionIndex> {
    return new ExclusionIndex(await this.handledKeys());
  }

  /** True when the customer was manually 제외(excluded): by its phone|expiry key or
   *  by its contract (phone + opendate), so a changed 약정 개월 keeps it excluded. */
  async isHandled(t: ExclusionTarget): Promise<boolean> {
    return (await this.exclusionIndex()).isHandled(t);
  }

  /**
   * Toggle the manual 제외(exclude) flag for a customer. Pass `opendate` (the item's
   * 개통일) so the contract key is stored/cleared too (audit B8); un-excluding clears
   * every stored form of both keys. A restored contract key arrives split at its last
   * bar ("open:<phone>", "<opendate>") and is stored as that contract key. Serialized.
   */
  async setHandled(phone: string, expiry: string, val: boolean, opendate?: string): Promise<void> {
    const p = String(phone ?? "");
    const targets = p.startsWith(EXCLUSION_CONTRACT_PREFIX)
      ? [exclusionContractKey(p.slice(EXCLUSION_CONTRACT_PREFIX.length), expiry)]
      : [dueKey(p, expiry), opendate ? exclusionContractKey(p, opendate) : null];
    const wanted = targets.filter((k): k is string => !!k);
    if (!wanted.length) return;
    return this.serialize(async () => {
      const keys = await this.handledKeys();
      // A contract-aware un-exclude also drops this phone's other phone|expiry keys:
      // the 미방문 list shows only the phone's CURRENT contract, so an older-expiry key
      // can only be this contract's pre-change key (or a dead one) — leaving it would
      // re-exclude the customer if the months setting is changed back.
      const digits = normalizePhone(p);
      const samePhoneLegacy = (k: string): boolean =>
        !val && !!opendate && !k.startsWith(EXCLUSION_CONTRACT_PREFIX) && k.slice(0, k.lastIndexOf("|")) === digits;
      if (val) {
        for (const k of wanted) keys.add(k);
      } else {
        for (const k of Array.from(keys)) {
          const norm = normalizeExclusionKey(k) ?? k;
          if (wanted.includes(norm) || samePhoneLegacy(norm)) keys.delete(k);
        }
      }
      await this.kv.set(HANDLED_KEY, JSON.stringify(Array.from(keys)));
    });
  }

  /** History screen: records newest first, optional text/date filter — ALL matches
   *  unless `limit` is given (no silent cap; page with searchPage). `query` matches
   *  the customer name or the phone text; a phone-like query (see isPhoneQuery) also
   *  matches the phone by DIGITS, so "010-1111-2222", "01011112222" and "1111-2222"
   *  find the same record (audit #46). start/end are inclusive ISO dates. */
  async search(query = "", start = "", end = "", limit = Infinity): Promise<SentRecord[]> {
    const rows = filterHistory(await this.all(), query, start, end);
    return Number.isFinite(limit) ? rows.slice(0, Math.max(0, limit)) : rows;
  }

  /** One page of search() plus the real total, for the 이력 screen's '더 보기'
   *  (audit 3-13). offset/limit are clamped (limit defaults to HISTORY_PAGE_SIZE). */
  async searchPage(opts: HistoryPageQuery = {}): Promise<HistoryPage> {
    const rows = filterHistory(await this.all(), opts.query ?? "", opts.start ?? "", opts.end ?? "");
    const offset = Math.max(0, Math.trunc(Number(opts.offset) || 0));
    const rawLimit = Math.trunc(Number(opts.limit) || 0);
    const limit = rawLimit > 0 ? rawLimit : HISTORY_PAGE_SIZE;
    const page = rows.slice(offset, offset + limit);
    return { rows: page, total: rows.length, offset, hasMore: offset + page.length < rows.length };
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
