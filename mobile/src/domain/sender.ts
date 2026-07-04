/**
 * Send (record) an outbound customer message for one due row, from "알림 보내기".
 * Dedup + record: a successful send is recorded into history so the customer is
 * never messaged twice for the same contract (dedup on phone+expiry).
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

/** The exact message that would be sent for this item (for preview/edit). */
export function renderAlertText(item: DueItem, cfg: AppConfig): string {
  const when = formatWhen(Number(item.milestone_offset || 0), parseIsoDate((item.expiry_date || "").trim()));
  return renderMessage(templateForRow(cfg, item as unknown as Record<string, unknown>), item, when);
}

/** A history record shape from a due item (+ the actual message body). */
export function dueItemToEntry(item: DueItem, body = ""): Omit<SentRecord, "channel" | "sent_at"> {
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
    body,
  };
}

/**
 * Send one alert. When `overrideText` is given (edited in the confirmation sheet)
 * it is sent verbatim; otherwise the template is rendered. The actual body is
 * stored in history so staff can later see exactly what each customer received.
 */
export async function sendAlert(
  item: DueItem,
  cfg: AppConfig,
  deps: SendDeps,
  overrideText?: string,
): Promise<SendOutcome> {
  const phone = (item.phone || "").trim();
  const expiry = (item.expiry_date || "").trim();
  if (!phone || !expiry) return { status: "error", error: "invalid item" };

  if (await deps.history.alreadySent(phone, expiry)) {
    return { status: "already" };
  }

  const body = overrideText ?? renderAlertText(item, cfg);
  let channel: string;
  if (cfg.deliver_alerts) {
    try {
      await deps.sendSms(phone, body);
    } catch (e) {
      // Native SmsPlugin already rejects with a user-facing Korean reason.
      const msg = e instanceof Error ? e.message : String(e);
      return { status: "error", error: msg || "문자 전송 실패" };
    }
    channel = "sms";
  } else {
    channel = "record-only";
  }

  const newly = await deps.history.recordSent(dueItemToEntry(item, body), channel, deps.nowIso());
  if (!newly) return { status: "already" };
  return { status: "sent", channel };
}

function parseIsoDate(iso: string) {
  const parts = iso.split("-").map((p) => Number(p));
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
    return makeDate(parts[0], parts[1], parts[2]);
  }
  const n = new Date();
  return makeDate(n.getFullYear(), n.getMonth() + 1, n.getDate());
}
