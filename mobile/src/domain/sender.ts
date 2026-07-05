/**
 * Send (record) an outbound customer message for one due row, from "알림 보내기".
 * Dedup + record: a successful send is recorded into history so the customer is
 * never messaged twice for the same contract (dedup on phone+expiry).
 */
import { formatWhen, monthsSinceOpen } from "./expiry";
import type { History, SentRecord } from "./history";
import { renderMessage } from "./notifier";
import { makeDate, today, type PlainDate } from "./plaindate";
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

/** Render a chosen template body for this item (fills {customer}/{when}/... ).
 *  {months}/{years} are the open→today elapsed time; `todayD` is injectable for
 *  tests and defaults to the current local day. {years} rounds to the nearest
 *  year (과반이 넘으면 올림), so a ~2-year contract reads "2년". */
export function renderTemplate(item: DueItem, body: string, todayD: PlainDate = today()): string {
  const when = formatWhen(Number(item.milestone_offset || 0), parseIsoDate((item.expiry_date || "").trim()));
  const raw = monthsSinceOpen(item.opendate || "", todayD);
  // Floor to 1 so a today/future/blank opendate never renders "0개월 전 / 0년전"
  // in a customer message. Real due customers are always many months out, so this
  // only guards data anomalies. {years} rounds (과반이 넘으면 올림).
  const months = Math.max(1, raw);
  const years = Math.max(1, Math.round(raw / 12));
  return renderMessage(body, item, when, { months, years });
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
 * Send one alert with an already-resolved message `body` (the caller picks the
 * matching template and renders it, or passes the text edited in the confirm
 * sheet). The body is sent verbatim and stored in history so staff can later
 * see exactly what each customer received.
 */
export async function sendAlert(
  item: DueItem,
  cfg: AppConfig,
  deps: SendDeps,
  body: string,
): Promise<SendOutcome> {
  const phone = (item.phone || "").trim();
  const expiry = (item.expiry_date || "").trim();
  if (!phone || !expiry) return { status: "error", error: "invalid item" };

  if (await deps.history.alreadySent(phone, expiry)) {
    return { status: "already" };
  }

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
