/**
 * Raw Poncle row -> DueItem builder, shared by the due scan (scan.ts) and the
 * 미방문 scan (unvisited.ts). Kept in its own module so neither imports the other.
 * Mirrors backend/scan.py._entry_from_row. `id` / `already_sent` are filled by
 * the caller.
 */
import { PlainDate, toIso } from "./plaindate";
import type { DueItem, PoncleRow } from "./types";

/** Read a Poncle field as a trimmed string ("" when absent). */
export function field(row: PoncleRow, name: string): string {
  const v = row[name];
  return v == null ? "" : String(v).trim();
}

/** Build a DueItem from an open-list row, its milestone offset, and its expiry. */
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
