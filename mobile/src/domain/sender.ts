/**
 * Send (record) an outbound customer message for one due row, from "알림 보내기".
 * Dedup + record: a successful send is recorded into history so the customer is
 * never messaged twice for the same contract (dedup on phone+expiry).
 */
import { formatWhen, monthsSinceOpen, parseOpendate } from "./expiry";
import type { History, SentRecord } from "./history";
import { renderMessage } from "./notifier";
import { daysUntil, makeDate, today, type PlainDate } from "./plaindate";
import type { AppConfig, DueItem, RecordSource } from "./types";

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

/**
 * D-day badge text from the signed days until expiry (expiry - today), shared by
 * the home card and its "why" detail: 0 -> '오늘 만료', 3 -> 'D-3', -2 -> 'D+2 지남'.
 */
export function formatDdayLabel(offsetDays: number): string {
  const n = Math.trunc(Number(offsetDays) || 0);
  if (n === 0) return "오늘 만료";
  if (n < 0) return `D+${-n} 지남`;
  return `D-${n}`;
}

/** Shown in place of {months}/{years} when the customer's 개통일 is unknown, so the
 *  confirm sheet visibly flags it (never a false '1개월 전'). The caller blocks
 *  sending while the text still contains it. */
export const OPENDATE_MISSING_MARK = "(개통일 확인 필요)";

/** Korean placeholder aliases (the labels of the 변수 chips) -> English tokens, so
 *  a staff member typing {고객명} by hand gets it filled like {customer}. */
export const KOREAN_TOKEN_ALIASES: Readonly<Record<string, string>> = {
  고객명: "customer",
  통신사: "telecom",
  모델: "model",
  만료일: "expiry",
  개통일: "opendate",
  시점: "when",
  요금제: "plan",
  경과개월: "months",
  경과년수: "years",
  담당: "staff",
  거래처: "agency",
  전화번호: "phone",
};

/** The 변수 chips of the template editor, in display order. Each inserts its KOREAN
 *  token ({고객명}) — what staff read and would type by hand — which renderTemplate
 *  resolves through KOREAN_TOKEN_ALIASES (I8). */
export const TEMPLATE_VAR_CHIPS: ReadonlyArray<{ label: string; token: string }> = [
  "고객명", "통신사", "모델", "만료일", "개통일", "시점", "요금제", "경과개월", "경과년수", "담당", "거래처", "전화번호",
].map((label) => ({ label, token: `{${label}}` }));

/** Every English placeholder renderMessage fills. */
const KNOWN_TOKENS: ReadonlySet<string> = new Set([
  "customer", "phone", "expiry", "opendate", "telecom", "agency", "plan",
  "model", "staff", "offset", "when", "months", "years",
]);

const TOKEN_RE = /\{([^{}\s]+)\}/g;

/** Rewrite Korean alias tokens ({고객명}) to their English form ({customer}).
 *  Unknown tokens are left untouched. Pure. */
export function resolveTokenAliases(body: string): string {
  return String(body ?? "").replace(TOKEN_RE, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(KOREAN_TOKEN_ALIASES, name) ? `{${KOREAN_TOKEN_ALIASES[name]}}` : m,
  );
}

/** Anything that LOOKS like a token: ASCII or full-width braces around one line of
 *  text, spaces allowed — so '{ 고객명 }' and '｛고객명｝' (never filled) are caught. */
const LOOSE_TOKEN_RE = /[{｛]([^{}｛｝\r\n]*)[}｝]/g;

function isKnownTokenName(name: string): boolean {
  return KNOWN_TOKENS.has(name) || Object.prototype.hasOwnProperty.call(KOREAN_TOKEN_ALIASES, name);
}

/** {tokens} in a template body that won't be filled — an unknown name, or a known
 *  one written with spaces or full-width braces ('{ 고객명 }', '｛고객명｝', I8) — so
 *  the editor warns on save. Each returned once, as written, in first-seen order
 *  (e.g. ["{이름}"]). */
export function unknownTemplateTokens(body: string): string[] {
  const out: string[] = [];
  for (const m of String(body ?? "").matchAll(LOOSE_TOKEN_RE)) {
    const fills = m[0].startsWith("{") && m[0].endsWith("}") && /^[^\s]+$/.test(m[1]) && isKnownTokenName(m[1]);
    if (fills) continue;
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/** True when a template body uses the open→today elapsed time ({months}/{years},
 *  or the Korean {경과개월}/{경과년수}). */
export function templateNeedsOpendate(body: string): boolean {
  return /\{(months|years)\}/.test(resolveTokenAliases(body));
}

/** Korean mobile number in canonical digits ("01012345678"), or "" when it is not
 *  one. Accepts hyphens/spaces and the +82 form (+82 10-…, +82 010-…, 8210…). THE
 *  shared rule (audit K3/L18) — native SmsPlugin.normalizeNumber and the 폰클 검색
 *  field must agree: a leading 82 (with or without '+') is the country code and the
 *  rest gets its 0 (10… -> 010…); a '+' followed by any other code is a foreign
 *  number and invalid. */
export function normalizeKrMobile(phone: string): string {
  const trimmed = String(phone ?? "").trim();
  let d = trimmed.replace(/[^0-9]/g, "");
  if (trimmed.startsWith("+") && !d.startsWith("82")) return ""; // foreign number
  if (d.startsWith("82")) {
    const rest = d.slice(2);
    d = rest.startsWith("0") ? rest : `0${rest}`;
  }
  return /^01[016789]\d{7,8}$/.test(d) ? d : "";
}

/** True for a Korean mobile number (010/011/016/017/018/019, 10-11 digits). */
export function isValidKrMobile(phone: string): boolean {
  return normalizeKrMobile(phone) !== "";
}

/** User-facing reason shown when a number fails isValidKrMobile. */
export const INVALID_MOBILE_MESSAGE = "휴대폰 번호 형식이 올바르지 않습니다 (010으로 시작하는 10~11자리)";

/** Korean carriers' single-SMS (단문) limit in EUC-KR bytes; above it -> 장문(LMS). */
export const SMS_MAX_BYTES = 90;
/** Korean carriers' LMS limit in bytes. */
export const LMS_MAX_BYTES = 2000;

/** GSM 03.38 default alphabet (1 septet each). */
const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
/** GSM 03.38 extension table (escape + char = 2 septets). */
const GSM7_EXT = "^{}\\[~]|€\f";

/** Length estimate of an outgoing message, shown under the send sheet's textarea. */
export interface SmsLengthInfo {
  /** User-visible characters (code points; an emoji is 1). */
  chars: number;
  /** EUC-KR-style byte count: ASCII 1, Hangul/CJK/other BMP 2, astral (emoji) 4. */
  bytes: number;
  /** 단문 when bytes <= SMS_MAX_BYTES, else 장문. */
  kind: "SMS" | "LMS";
  /** Over the carrier LMS limit (LMS_MAX_BYTES). */
  tooLong: boolean;
  /** Android SmsManager encoding the text would use. */
  encoding: "GSM7" | "UCS2";
  /** Android multipart estimate (divideMessage): parts the SMS is split into; 0 when empty. */
  segments: number;
  /** Korean one-liner, e.g. '10자 · 20/90바이트 (단문)'. */
  label: string;
}

function eucKrBytes(cp: number): number {
  if (cp < 0x80) return 1;
  return cp > 0xffff ? 4 : 2;
}

/**
 * Estimate how an SMS body will go out. bytes/kind follow the Korean carrier rule
 * (90-byte 단문, else 장문/LMS, EUC-KR: Hangul 2 bytes, ASCII 1; characters EUC-KR
 * can't encode such as emoji are counted as 4). segments follows Android's
 * divideMessage (what SmsPlugin sends with): GSM-7 when every char is in the GSM
 * alphabet (160 single / 153 per part, extension chars take 2), else UCS-2 (70
 * UTF-16 units single / 67 per part). An estimate — carriers may still merge parts.
 */
export function smsLengthInfo(text: string): SmsLengthInfo {
  const s = String(text ?? "");
  let chars = 0;
  let bytes = 0;
  let septets = 0;
  let gsm = true;
  for (const ch of s) {
    chars++;
    bytes += eucKrBytes(ch.codePointAt(0) ?? 0);
    if (!gsm) continue;
    if (GSM7_BASIC.includes(ch)) septets += 1;
    else if (GSM7_EXT.includes(ch)) septets += 2;
    else gsm = false;
  }
  const encoding: SmsLengthInfo["encoding"] = gsm ? "GSM7" : "UCS2";
  const units = gsm ? septets : s.length; // UCS-2 counts UTF-16 units (emoji = 2)
  const [single, perPart] = gsm ? [160, 153] : [70, 67];
  const segments = units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / perPart);
  const kind: SmsLengthInfo["kind"] = bytes <= SMS_MAX_BYTES ? "SMS" : "LMS";
  const label =
    kind === "SMS"
      ? `${chars}자 · ${bytes}/${SMS_MAX_BYTES}바이트 (단문)`
      : `${chars}자 · ${bytes}바이트 · 장문(LMS) / 분할 ${segments}건`;
  return { chars, bytes, kind, tooLong: bytes > LMS_MAX_BYTES, encoding, segments, label };
}

/** True when the item's 개통일 parses (so {months}/{years} can be computed). */
export function hasKnownOpendate(item: Pick<DueItem, "opendate">): boolean {
  return parseOpendate(String(item.opendate ?? "")) !== null;
}

/** Render a chosen template body for this item (fills {customer}/{when}/... ).
 *  {when} is derived from the expiry vs `todayD` (never a cached milestone_offset),
 *  so a list cached days ago or a 미방문 customer reads correctly ('D+N' once passed).
 *  {offset} is the same signed days-until-expiry as of `todayD` (negative once
 *  passed) on every screen — never the item's cached/per-screen milestone_offset
 *  (home counted D-, 미방문 D+; audit L23).
 *  {months}/{years} are the open→today elapsed time; with an unknown 개통일 they
 *  render OPENDATE_MISSING_MARK. `todayD` is injectable for tests and defaults to the
 *  current local day. {years} rounds to the nearest year (과반이 넘으면 올림). */
export function renderTemplate(item: DueItem, rawBody: string, todayD: PlainDate = today()): string {
  const body = resolveTokenAliases(rawBody); // {고객명} -> {customer} (manual Korean tokens)
  const expiryIso = (item.expiry_date || "").trim();
  const offset = daysUntil(expiryIso, todayD) ?? Number(item.milestone_offset || 0);
  const when = formatWhen(offset, parseIsoDate(expiryIso));
  const entry = { ...item, milestone_offset: offset }; // {offset} as of today (L23)
  if (!hasKnownOpendate(item)) {
    // Keep the gap visible: '{months}' -> marker (renderMessage leaves non-\w tokens).
    const marked = String(body ?? "").replace(/\{(months|years)\}/g, OPENDATE_MISSING_MARK);
    return renderMessage(marked, entry, when);
  }
  const raw = monthsSinceOpen(item.opendate || "", todayD);
  // Floor to 1 so a today/future opendate never renders "0개월 전 / 0년전" in a
  // customer message. Real due customers are always many months out, so this only
  // guards data anomalies. {years} rounds (과반이 넘으면 올림).
  const months = Math.max(1, raw);
  const years = Math.max(1, Math.round(raw / 12));
  return renderMessage(body, entry, when, { months, years });
}

/** A history record shape from a due item (+ the actual message body). The item's
 *  milestone `source` is stored so the same contract's stage can be matched later
 *  even if its expiry is computed differently (SentIndex). `source` overrides the
 *  item's: pass "manual" for a 직접 입력 send outside a milestone (조회 '여유' 고객),
 *  which is then never counted as that milestone's send (audit B1). */
export function dueItemToEntry(item: DueItem, body = "", source?: RecordSource): Omit<SentRecord, "channel" | "sent_at"> {
  const entry: Omit<SentRecord, "channel" | "sent_at"> = {
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
  const src: unknown = source ?? item.source;
  if (src === "keepdate" || src === "term" || src === "manual") entry.source = src;
  return entry;
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
    if (!isValidKrMobile(phone)) return { status: "error", error: INVALID_MOBILE_MESSAGE };
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
