/**
 * Scan orchestrator: fetch -> compute expiry -> build the "due list". Port of
 * backend/scan.py. Produces the list of customers whose contract is due today
 * (per the configured milestones) and flags which were already alerted. Sending
 * is a separate, explicit per-row action (sender.ts).
 */
import { candidateOpenDates, dueMilestones } from "./expiry";
import type { History } from "./history";
import { PoncleClient, PoncleGateway, SessionExpired } from "./poncle-client";
import { PlainDate, toIso, today } from "./plaindate";
import type { AppConfig, DueItem, PoncleRow } from "./types";

export type ScanState = "idle" | "scanning" | "session_expired" | "error";

export interface ScanResult {
  status: "ok" | "session_expired" | "error";
  state: ScanState;
  results: DueItem[];
  targets: number;
  sent: number;
  pending: number;
  error?: string;
}

function field(row: PoncleRow, name: string): string {
  const v = row[name];
  return v == null ? "" : String(v).trim();
}

/** Mirror scan._entry_from_row: raw Poncle row -> a due-list item (id/already_sent
 *  filled by the caller). */
export function entryFromRow(row: PoncleRow, offset: number, expiry: PlainDate): DueItem {
  return {
    id: "",
    phone: field(row, "openphone"),
    customer: field(row, "customer"),
    opendate: field(row, "opendate"),
    expiry_date: toIso(expiry),
    milestone_offset: offset,
    telecom: field(row, "telecomx") || field(row, "telecom"),
    agency: field(row, "agencytitle"),
    openhow: field(row, "openhowx"),
    plan: field(row, "plan"),
    model: field(row, "model"),
    staff: field(row, "membername") || field(row, "username"),
    already_sent: false,
  };
}

/** Run one scan. Pure of any UI; returns the due list + summary. */
export async function runScan(
  gw: PoncleGateway,
  cfg: AppConfig,
  history: History,
  todayD: PlainDate = today(),
): Promise<ScanResult> {
  const empty = { results: [] as DueItem[], targets: 0, sent: 0, pending: 0 };

  let ok = false;
  try {
    ok = await gw.check();
  } catch {
    ok = false;
  }
  if (!ok) {
    return { status: "session_expired", state: "session_expired", ...empty };
  }

  const client = new PoncleClient(gw, cfg);
  const dates = candidateOpenDates(cfg, todayD);
  let rows: PoncleRow[];
  try {
    rows = await client.fetchCandidates(dates);
  } catch (e) {
    if (e instanceof SessionExpired) {
      return { status: "session_expired", state: "session_expired", ...empty };
    }
    return { status: "error", state: "error", error: String(e), ...empty };
  }

  const results: DueItem[] = [];
  for (const row of rows) {
    for (const [offset, expiry] of dueMilestones(row, cfg, todayD)) {
      const item = entryFromRow(row, offset, expiry);
      item.already_sent = await history.alreadySent(item.phone, item.expiry_date, offset);
      item.id = `${item.phone}|${item.expiry_date}|${offset}`;
      results.push(item);
    }
  }

  // unsent before sent, then by opendate ascending (mirror scan.py sort key).
  results.sort((a, b) => {
    if (a.already_sent !== b.already_sent) return a.already_sent ? 1 : -1;
    return a.opendate < b.opendate ? -1 : a.opendate > b.opendate ? 1 : 0;
  });

  const sent = results.filter((r) => r.already_sent).length;
  return {
    status: "ok",
    state: "idle",
    results,
    targets: results.length,
    sent,
    pending: results.length - sent,
  };
}
