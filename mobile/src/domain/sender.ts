/**
 * Send (record) an outbound customer message for one due row, from "알림 보내기".
 * Port of backend/sender.py, with delivery via the native SMS plugin instead of
 * the PC phone-link. Dedup + record are the same: a successful send is recorded
 * into history so the customer is never messaged twice for the same milestone.
 */
import { formatWhen } from "./expiry";
import type { History, SentRecord } from "./history";
import { renderMessage, templateForRow } from "./notifier";
import { makeDate } from "./plaindate";
import type { AppConfig, DueItem } from "./types";

export interface SendDeps {
  history: History;
  /** Deliver the SMS from this device. Rejects on permission/transport failure. */
  sendSms(phone: string, text: string): Promise<void>;
  /** Current local ISO datetime (injected for testability). */
  nowIso(): string;
}

export interface SendOutcome {
  status: "sent" | "already" | "error";
  channel?: string;
  error?: string;
}

export async function sendAlert(item: DueItem, cfg: AppConfig, deps: SendDeps): Promise<SendOutcome> {
  const phone = (item.phone || "").trim();
  const expiry = (item.expiry_date || "").trim();
  const offset = Number(item.milestone_offset || 0);
  if (!phone || !expiry) return { status: "error", error: "invalid item" };

  if (await deps.history.alreadySent(phone, expiry, offset)) {
    return { status: "already" };
  }

  let channel: string;
  if (cfg.deliver_alerts) {
    const when = formatWhen(offset, parseIsoDate(expiry));
    const text = renderMessage(templateForRow(cfg, item as unknown as Record<string, unknown>), item, when);
    try {
      await deps.sendSms(phone, text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { status: "error", error: "문자 전송 실패: " + msg };
    }
    channel = "sms";
  } else {
    channel = "record-only";
  }

  const newly = await deps.history.recordSent(entryOf(item), channel, deps.nowIso());
  if (!newly) return { status: "already" };
  return { status: "sent", channel };
}

function entryOf(item: DueItem): Omit<SentRecord, "channel" | "sent_at"> {
  return {
    phone: (item.phone || "").trim(),
    customer: item.customer || "",
    opendate: item.opendate || "",
    expiry_date: (item.expiry_date || "").trim(),
    milestone_offset: Number(item.milestone_offset || 0),
    telecom: item.telecom || "",
    agency: item.agency || "",
    plan: item.plan || "",
    model: item.model || "",
    openhow: item.openhow || "",
    staff: item.staff || "",
  };
}

function parseIsoDate(iso: string) {
  const parts = iso.split("-").map((p) => Number(p));
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
    return makeDate(parts[0], parts[1], parts[2]);
  }
  const n = new Date();
  return makeDate(n.getFullYear(), n.getMonth() + 1, n.getDate());
}
