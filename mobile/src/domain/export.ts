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

/** Parse + validate a pasted/opened backup. Returns null if it isn't one. */
export function parseBackup(text: string): Backup | null {
  try {
    const obj = JSON.parse(text);
    if (!obj || obj.app !== "poncle-expiry" || !Array.isArray(obj.history)) return null;
    return obj as Backup;
  } catch {
    return null;
  }
}
