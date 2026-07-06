/**
 * Pure helpers for exporting / backing up local data (no I/O). CSV for handing a
 * manager a list; a JSON backup so send history + settings survive a phone change
 * or reinstall (which otherwise wipes the dedup history and risks re-messaging the
 * whole customer book).
 */
import type { SentRecord } from "./history";
import type { AppConfig } from "./types";

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

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Send history -> CSV text (BOM-prefixed so Excel reads Korean correctly). */
export function historyToCsv(rows: SentRecord[]): string {
  const header = ["발송일시", "개통일", "거래처", "고객명", "개통번호", "종류", "통신사", "모델명", "상태", "문자내용"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.sent_at?.replace("T", " ") ?? "",
        r.opendate ?? "",
        r.agency ?? "",
        r.customer ?? "",
        r.phone ?? "",
        r.openhow ?? "",
        r.telecom ?? "",
        r.model ?? "",
        CHANNEL_LABEL[r.channel] ?? r.channel ?? "",
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
}

/** Build a JSON backup of settings + send history. */
export function buildBackup(config: AppConfig | null, history: SentRecord[], nowIso: string): Backup {
  return { app: "poncle-expiry", version: 1, exported_at: nowIso, config, history };
}

/** Whether restoring `incoming` records over `existing` ones would DESTROY history —
 *  i.e. the restore shrinks the log (fewer records, or wipes a non-empty log). A
 *  restore is a full replaceAll, so a wrong/old/empty file silently drops the very
 *  dedup history that stops the whole customer book being re-messaged. The caller
 *  must confirm before replacing when this is true. Growing/equal restores are safe. */
export function restoreLosesHistory(existing: number, incoming: number): boolean {
  return existing > 0 && incoming < existing;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** Host allowlist for a restored/entered poncle_base_url — must be poncle.co.kr
 *  (or a subdomain). Blocks a malicious/typo backup from repointing native traffic
 *  (session cookie, scan requests) at an arbitrary host. */
export function isAllowedPoncleBaseUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const h = u.hostname.toLowerCase();
    return h === "poncle.co.kr" || h.endsWith(".poncle.co.kr");
  } catch {
    return false;
  }
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
  return rec;
}

/** Sanitize a restored config: drop a poncle_base_url that isn't an allowed host
 *  (falls back to the default on merge) so a hostile backup can't repoint traffic. */
function sanitizeConfig(raw: unknown): AppConfig | null {
  if (!isRecord(raw)) return null;
  if ("poncle_base_url" in raw && !isAllowedPoncleBaseUrl(raw.poncle_base_url)) {
    const { poncle_base_url: _dropped, ...rest } = raw;
    return rest as unknown as AppConfig;
  }
  return raw as unknown as AppConfig;
}

/** Parse + validate a pasted/opened backup. Returns null if it isn't one. Untrusted
 *  records are coerced to the SentRecord shape (bad ones dropped) and a config with a
 *  non-poncle base URL has that field stripped. */
export function parseBackup(text: string): Backup | null {
  try {
    const obj = JSON.parse(text);
    if (!isRecord(obj) || obj.app !== "poncle-expiry" || !Array.isArray(obj.history)) return null;
    const history = obj.history.map(sanitizeRecord).filter((r): r is SentRecord => r !== null);
    const config = obj.config == null ? null : sanitizeConfig(obj.config);
    return { app: "poncle-expiry", version: 1, exported_at: str(obj.exported_at), config, history };
  } catch {
    return null;
  }
}
