/**
 * Pure helpers for exporting / backing up local data (no I/O). CSV for handing a
 * manager a list; a JSON backup so send history + settings survive a phone change
 * or reinstall (which otherwise wipes the dedup history and risks re-messaging the
 * whole customer book).
 */
import type { CohortEntry } from "./cohort";
import { TEMPLATE_SCHEMA_VERSION, restoreConfig } from "./config";
import {
  normalizeExclusionKey,
  recordKey,
  sanitizePrevSend,
  sanitizeSendStats,
  sendStats,
  sentStateOf,
  type SentRecord,
} from "./history";
import { dueKey, normalizePhone } from "./keepdate";
import { RECORD_SOURCES, type AppConfig, type RecordSource } from "./types";

// The base-URL allowlist is a restore field check (config.ts FIELD_CHECKS — a
// disallowed URL is reported as skipped, audit L8); re-exported for existing callers.
export { isAllowedPoncleBaseUrl } from "./config";

// The restore merge lives with History (History.mergeRestore runs it inside the
// history lock — audit B6); re-exported here for existing callers.
export { mergeHistory } from "./history";

const CHANNEL_LABEL: Record<string, string> = {
  sms: "발송",
  "record-only": "기록만",
  skipped: "제외",
};

/** The only channel values the app produces. A restored/hostile backup carrying
 *  anything else (e.g. an HTML payload aimed at the 이력 list's innerHTML) is
 *  coerced to "record-only" so it can never reach a render path unescaped. */
const CHANNELS = new Set(["sms", "record-only", "skipped"]);
function normalizeChannel(v: unknown): string {
  const s = str(v);
  if (s === "") return "sms"; // preserve the prior default for a blank/missing field
  // Any non-empty value that isn't a known channel (e.g. an HTML payload aimed at the
  // 이력 list's innerHTML) is coerced to a safe known value so it never renders.
  return CHANNELS.has(s) ? s : "record-only";
}

/** A cell a spreadsheet would run as a formula (or that starts with a control
 *  char): = + - @ TAB CR. Prefixed with ' so Excel shows it as text (#42). */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function csvCell(v: unknown): string {
  const raw = String(v ?? "");
  const s = FORMULA_LEAD.test(raw) ? `'${raw}` : raw;
  // A bare CR splits the row in Excel just like LF: quote it too.
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 상태 column: a send later reported failed must not read '발송'. */
function statusLabel(r: SentRecord): string {
  if (sentStateOf(r) === "failed") return "발송 실패";
  return CHANNEL_LABEL[r.channel] ?? r.channel ?? "";
}

/** 구분 column: which milestone (or 직접 입력) the record belongs to (I11). */
const SOURCE_LABEL: Record<RecordSource, string> = { keepdate: "요금제 유지", term: "약정 만료", manual: "직접 입력" };

/** 실패 사유 column: the failed send's reason, or a 재발송's failure that left the
 *  earlier send standing. */
function failReasonLabel(r: SentRecord): string {
  if (sentStateOf(r) === "failed") return r.fail_reason ?? "";
  return r.resend_fail_reason ? `재발송 실패: ${r.resend_fail_reason}` : "";
}

/** Send history -> CSV text (BOM-prefixed so Excel reads Korean correctly).
 *  Every cell is formula-neutralized and CR/LF-safe (#42). 구분 / 실패 사유 / 발송 횟수
 *  (counted real sends, sendStats) were added in I11; 문자내용 stays last. */
export function historyToCsv(rows: SentRecord[]): string {
  const header = [
    "발송일시", "개통일", "만료일", "거래처", "고객명", "개통번호", "종류", "통신사", "모델명", "요금제", "담당", "상태",
    "구분", "실패 사유", "발송 횟수", "문자내용",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.sent_at?.replace("T", " ") ?? "",
        r.opendate ?? "",
        r.expiry_date ?? "",
        r.agency ?? "",
        r.customer ?? "",
        r.phone ?? "",
        r.openhow ?? "",
        r.telecom ?? "",
        r.model ?? "",
        r.plan ?? "",
        r.staff ?? "",
        statusLabel(r),
        r.source ? SOURCE_LABEL[r.source] ?? "" : "",
        failReasonLabel(r),
        String(sendStats(r).count),
        r.body ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return "﻿" + lines.join("\r\n");
}

export interface Backup {
  app: "poncle-expiry";
  version: 1;
  exported_at: string;
  config: AppConfig | null;
  history: SentRecord[];
  /** 미방문 수동 제외 keys (normalized phone|expiry). [] for a backup made before
   *  v1.2.17 (the field is absent there; older apps ignore it). */
  excluded: string[];
  /** 재방문 전환율 cohort log. [] for an older backup. */
  cohort: CohortEntry[];
  /** Template list schema (TEMPLATE_SCHEMA_VERSION) the backup was written with, so a
   *  restore never mistakes a 2단계 list for a pre-v2 one (I9/L9). 0 = not recorded
   *  (backup from before v1.2.17); older apps ignore the field. */
  template_schema: number;
}

/** Optional extra state carried by a backup (#55). */
export interface BackupExtras {
  excluded?: Iterable<string>;
  cohort?: readonly CohortEntry[];
}

/** Settings that belong to THIS device only and never travel in a backup:
 *  test_phone is "my own number" for test sends — restoring a colleague's backup
 *  must not redirect this phone's test SMS to their number. */
const DEVICE_LOCAL_CONFIG_KEYS = ["test_phone"] as const;

function withoutDeviceLocal<T extends object>(cfg: T): T {
  const out = { ...cfg } as Record<string, unknown>;
  for (const k of DEVICE_LOCAL_CONFIG_KEYS) delete out[k];
  return out as T;
}

/** Build a JSON backup of settings + send history (device-local keys excluded),
 *  plus the 미방문 제외 list and the cohort log (#55) so a restore keeps them. */
export function buildBackup(config: AppConfig | null, history: SentRecord[], nowIso: string, extras: BackupExtras = {}): Backup {
  return {
    app: "poncle-expiry",
    version: 1,
    exported_at: nowIso,
    config: config ? withoutDeviceLocal(config) : null,
    history,
    excluded: Array.from(extras.excluded ?? []),
    cohort: (extras.cohort ?? []).map((e) => ({ ...e })),
    template_schema: TEMPLATE_SCHEMA_VERSION,
  };
}

/** What a restore of `backup` would change on this phone (I9), in the shape the
 *  restore confirm (ui/restore-summary) takes. `templatesAfter`/`deliverAfter` are
 *  null when the file carries no settings. Pure. */
export interface RestoreFacts {
  exportedAt: string;
  backupHistory: number;
  currentHistory: number;
  /** Customers this phone has that the file lacks (kept by the merge). */
  missing: number;
  templatesBefore: number;
  templatesAfter: number | null;
  templatesChanged: boolean;
  deliverBefore: boolean;
  deliverAfter: boolean | null;
  /** The backup's template_schema (0 = not recorded). */
  templateSchema: number;
}

export function restoreFacts(backup: Backup, currentHistory: readonly SentRecord[], currentCfg: AppConfig): RestoreFacts {
  const restored = backup.config
    ? restoreConfig(backup.config, currentCfg, { templateSchema: backup.template_schema }).config
    : null;
  const before = currentCfg.templates ?? [];
  return {
    exportedAt: backup.exported_at,
    backupHistory: backup.history.length,
    currentHistory: currentHistory.length,
    missing: missingFromBackup(currentHistory, backup.history),
    templatesBefore: before.length,
    templatesAfter: restored ? (restored.templates ?? []).length : null,
    templatesChanged: !!restored && JSON.stringify(restored.templates ?? []) !== JSON.stringify(before),
    deliverBefore: !!currentCfg.deliver_alerts,
    deliverAfter: restored ? !!restored.deliver_alerts : null,
    templateSchema: backup.template_schema,
  };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** One untrusted exclusion key -> normalized phone|yyyy-mm-dd, or a contract key
 *  "open:<phone>|<개통 yyyy-mm-dd>" (audit B8); null when malformed. */
function sanitizeExcludedKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const bar = raw.lastIndexOf("|");
  if (bar <= 0) return null;
  if (!ISO_DAY.test(raw.slice(bar + 1).trim())) return null;
  const key = normalizeExclusionKey(raw);
  return key && normalizePhone(key.slice(0, key.lastIndexOf("|"))) ? key : null;
}

/** Untrusted exclusion list -> unique normalized keys (malformed entries dropped). */
function sanitizeExcludedList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const k of raw) {
    const key = sanitizeExcludedKey(k);
    if (key) out.add(key);
  }
  return Array.from(out);
}

/** One untrusted cohort entry, typed field by field — a wrong type drops the entry
 *  (informed:"false" is truthy and would inflate the 안내 효과). firstSeen falls
 *  back to the expiry day. */
function sanitizeCohortEntry(raw: unknown): CohortEntry | null {
  if (!isRecord(raw)) return null;
  const phone = typeof raw.phone === "string" ? raw.phone.trim() : "";
  const expiry = typeof raw.expiry === "string" ? raw.expiry.trim() : "";
  if (!normalizePhone(phone) || !ISO_DAY.test(expiry)) return null;
  if (typeof raw.informed !== "boolean" || typeof raw.revisited !== "boolean") return null;
  const firstSeen = typeof raw.firstSeen === "string" && ISO_DAY.test(raw.firstSeen) ? raw.firstSeen : expiry;
  const base: CohortEntry = { phone, expiry, informed: raw.informed, revisited: raw.revisited, firstSeen };
  // Contract 개통일 (cohort L5): kept only when it is a real yyyy-mm-dd.
  const entry = typeof raw.opendate === "string" && ISO_DAY.test(raw.opendate) ? { ...base, opendate: raw.opendate } : base;
  // Early re-contract day (cohort L3): kept only when it is a real yyyy-mm-dd.
  return typeof raw.resolvedOn === "string" && ISO_DAY.test(raw.resolvedOn)
    ? { ...entry, resolvedOn: raw.resolvedOn }
    : entry;
}

function sanitizeCohortList(raw: unknown): CohortEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeCohortEntry).filter((e): e is CohortEntry => e !== null);
}

/** The backup's exclusion keys this phone does not already have (compared
 *  normalized, so a legacy hyphenated key on the phone still matches). Pure. */
export function excludedKeysToAdd(current: ReadonlySet<string>, incoming: readonly string[]): string[] {
  const have = new Set<string>();
  for (const k of current) have.add(sanitizeExcludedKey(k) ?? k);
  const out: string[] = [];
  for (const k of incoming) {
    const key = sanitizeExcludedKey(k);
    if (key && !have.has(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * Restore the cohort log as a UNION by phone|expiry: a customer in both keeps the
 * stronger facts (informed / revisited OR-ed) and the earliest firstSeen. Entries
 * outside the 집계 window age out on the next scan as usual. Pure.
 */
export function mergeCohort(current: readonly CohortEntry[], incoming: readonly CohortEntry[]): CohortEntry[] {
  const byKey = new Map<string, CohortEntry>();
  for (const e of current) byKey.set(dueKey(e.phone, e.expiry), { ...e });
  for (const e of incoming) {
    const k = dueKey(e.phone, e.expiry);
    const cur = byKey.get(k);
    if (!cur) {
      byKey.set(k, { ...e });
      continue;
    }
    const firstSeen = [cur.firstSeen, e.firstSeen].filter((d) => !!d).sort()[0] ?? cur.firstSeen;
    const resolvedOn = [cur.resolvedOn, e.resolvedOn].filter((d): d is string => !!d).sort()[0];
    const opendate = cur.opendate || e.opendate;
    const merged: CohortEntry = {
      ...cur, informed: cur.informed || e.informed, revisited: cur.revisited || e.revisited, firstSeen,
      ...(opendate ? { opendate } : {}),
    };
    byKey.set(k, resolvedOn ? { ...merged, resolvedOn } : merged);
  }
  return Array.from(byKey.values());
}

/** How many of the CURRENT records' dedup keys (normalized phone|expiry) the backup
 *  does not carry — i.e. customers whose send history a plain replace would erase.
 *  Compares keys, not counts: a same-size or larger file can still be a different
 *  store's history. */
export function missingFromBackup(existing: readonly SentRecord[], incoming: readonly SentRecord[]): number {
  const inKeys = new Set(incoming.map(recordKey));
  const missing = new Set<string>();
  for (const r of existing) {
    const k = recordKey(r);
    if (!inKeys.has(k)) missing.add(k);
  }
  return missing.size;
}

/** Untrusted template_schema -> a small non-negative integer, else 0 (unknown). */
function sanitizeSchema(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 1000 ? raw : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}


/** Coerce one untrusted backup element into a well-formed SentRecord. Returns null
 *  when the essential keys (phone + expiry_date) are missing, so a corrupt/hostile
 *  file can't inject non-string fields that later throw (e.g. sent_at.slice) or
 *  collide the dedup key. */
export function sanitizeRecord(raw: unknown): SentRecord | null {
  if (!isRecord(raw)) return null;
  const phone = str(raw.phone).trim();
  const expiry = str(raw.expiry_date).trim();
  if (!phone || !expiry) return null;
  const offset = Number(raw.milestone_offset);
  const rec: SentRecord = {
    phone,
    customer: str(raw.customer),
    opendate: str(raw.opendate),
    expiry_date: expiry,
    milestone_offset: Number.isFinite(offset) ? offset : 0,
    telecom: str(raw.telecom),
    agency: str(raw.agency),
    plan: str(raw.plan),
    model: str(raw.model),
    openhow: str(raw.openhow),
    staff: str(raw.staff),
    channel: normalizeChannel(raw.channel),
    sent_at: str(raw.sent_at),
  };
  if (raw.body != null) rec.body = str(raw.body);
  // Milestone stage (#19): lets a restored record still match the same contract
  // when the expiry key drifted (약정 개월 changed). Only known values are kept.
  // "manual" = a 직접 입력 send outside any milestone (never satisfies one).
  if ((RECORD_SOURCES as readonly unknown[]).includes(raw.source)) rec.source = raw.source as RecordSource;
  // Async send outcome: a failed send must stay failed after a restore (else it
  // would silently count as sent again). Only known values are kept.
  if (raw.delivery === "delivered" || raw.delivery === "failed") rec.delivery = raw.delivery;
  if (rec.delivery === "failed" && raw.fail_reason != null) rec.fail_reason = str(raw.fail_reason);
  if (typeof raw.sms_id === "string" && raw.sms_id) rec.sms_id = raw.sms_id;
  // A 재발송's backup of the earlier real send (restored if the resend fails).
  const prevSent = sanitizePrevSend(raw.prev_sent);
  if (prevSent) rec.prev_sent = prevSent;
  if (raw.resend_fail_reason != null && raw.resend_fail_reason !== "") rec.resend_fail_reason = str(raw.resend_fail_reason);
  // 재발송 bookkeeping (#57): the first send's time and how many sends there were,
  // validated by the same rule History uses to store them.
  return { ...rec, ...sanitizeSendStats(raw) };
}

/** How a Capacitor Share.share() rejection should be treated. */
export type ShareErrorKind = "cancelled" | "unavailable" | "failed";

/**
 * Classify a Share.share() rejection. The user closing the share sheet rejects
 * too (Android: "Share canceled"; web: AbortError) — that is a CANCEL, not a
 * failure: no fallback share, no clipboard copy, no "backed up" bookkeeping.
 * "unavailable" = no share capability at all (web preview: UNAVAILABLE/UNIMPLEMENTED).
 */
export function classifyShareError(e: unknown): ShareErrorKind {
  if (typeof e !== "object" || e === null) return "failed";
  const { name, code, message } = e as { name?: unknown; code?: unknown; message?: unknown };
  const msg = typeof message === "string" ? message : "";
  if (name === "AbortError" || /cancel/i.test(msg)) return "cancelled";
  if (code === "UNAVAILABLE" || code === "UNIMPLEMENTED" || /not (available|implemented)/i.test(msg)) {
    return "unavailable";
  }
  return "failed";
}

/** Sanitize a restored config: device-local keys removed. Field values are NOT
 *  applied from here — restoreConfig (config.ts) type-checks every field and drops a
 *  poncle_base_url that isn't an allowed host, keeping THIS phone's value and
 *  REPORTING it as skipped (audit L8; it used to vanish silently here). */
function sanitizeConfig(raw: unknown): AppConfig | null {
  if (!isRecord(raw)) return null;
  return withoutDeviceLocal(raw) as unknown as AppConfig; // an old backup may still carry test_phone
}

/** Parse + validate a pasted/opened backup. Returns null if it isn't one. Untrusted
 *  records are coerced to the SentRecord shape (bad ones dropped), the config is
 *  passed on for restoreConfig's field checks, and the 제외 list / cohort log are
 *  type-checked entry by entry (malformed ones dropped; absent -> []). */
export function parseBackup(text: string): Backup | null {
  try {
    const obj = JSON.parse(text);
    if (!isRecord(obj) || obj.app !== "poncle-expiry" || !Array.isArray(obj.history)) return null;
    const history = obj.history.map(sanitizeRecord).filter((r): r is SentRecord => r !== null);
    const config = obj.config == null ? null : sanitizeConfig(obj.config);
    return {
      app: "poncle-expiry",
      version: 1,
      exported_at: str(obj.exported_at),
      config,
      history,
      excluded: sanitizeExcludedList(obj.excluded),
      cohort: sanitizeCohortList(obj.cohort),
      template_schema: sanitizeSchema(obj.template_schema),
    };
  } catch {
    return null;
  }
}
