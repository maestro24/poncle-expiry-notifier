/**
 * The confirm-send sheet (템플릿 선택 + 편집 + 발송) and the send/record path.
 */
import { countsAsSent, isManualRecord, recordKey, sentStateOf, withResendBackup, type SentRecord } from "../domain/history";
import { normalizePhone } from "../domain/keepdate";
import { addDays, today, toIso } from "../domain/plaindate";
import { OPENDATE_MISSING_MARK, dueItemToEntry, hasKnownOpendate, isValidKrMobile, renderTemplate, smsLengthInfo, templateNeedsOpendate } from "../domain/sender";
import { matchingTemplates } from "../domain/template-match";
import type { DueItem, RecordSource } from "../domain/types";
import { openAppSettings } from "../native/adapters";
import { INVALID_NUMBER_MESSAGE, sendSmsTracked } from "../native/sms";
import { appAlert, appConfirm } from "../ui/dialog";
import { closeModal, openModal } from "../ui/modal";
import { SendVolumeMeter } from "../ui/send-volume";
import { smsLengthLabel } from "../ui/sms-length";
import { history, S } from "../app/state";
import { hooks } from "../app/hooks";
import { $, esc, nowIso, toast } from "../app/dom";
import { isDegraded, clockBlocksSend } from "../app/status";
import { reconcileSentFlags } from "../app/sent-state";
import { INFLIGHT_SMS_IDS, TEST_SMS_IDS, scheduleResultChecks } from "./send-results";

/** After a send/record, re-derive every home row's state from the log (key-based,
 *  so a stale captured object or a copy from 조회/미방문 can't leave the home list
 *  out of sync) and refresh the list the send came from. */
async function markHandled(item: DueItem, manual: boolean): Promise<void> {
  // A 직접 입력 (manual) send satisfies no milestone (B1): the item keeps its state.
  if (!manual) {
    // Same-contract fallback (B9): a resend upserted under the record's own key.
    const rec = await history.findRecord(item, S.CFG);
    item.sent_state = sentStateOf(rec);
    item.already_sent = item.sent_state === "sent" || item.sent_state === "skipped";
  }
  await reconcileSentFlags();
  hooks.rerenderCurrent();
}

interface ConfirmOptions {
  /** Don't pre-fill a matched template (조회: 안내 시점이 아닌 고객). */
  noAutoTemplate?: boolean;
  /** Store the send as this record source instead of the item's milestone. "manual"
   *  = 직접 입력 outside any milestone (조회 '여유' 고객): never counts as a
   *  milestone's send (audit B1, contract C1). */
  recordSource?: RecordSource;
}

/** The stored record a send to `item` updates (재발송 upsert), or null:
 *  - a manual send: only an earlier MANUAL record of the same key (a milestone
 *    record is never replaced by — or merged into — a manual one);
 *  - a milestone send: exact key, else the same contract+stage under a drifted
 *    expiry (findRecord), so the resend lands on that record (B9). */
async function findPrevRecord(item: DueItem, manual: boolean): Promise<SentRecord | null> {
  if (!manual) return history.findRecord(item, S.CFG);
  const key = recordKey({ phone: item.phone, expiry_date: item.expiry_date, source: "manual" });
  const all = await history.exportAll();
  return all.filter((r) => isManualRecord(r) && recordKey(r) === key).pop() ?? null;
}

export function onSend(item: DueItem, opts: ConfirmOptions = {}): Promise<void> {
  // Record-only test rows can't demonstrate delivery; say so and stop.
  if (item.test && !S.CFG.deliver_alerts) {
    toast("테스트 대상: ‘실제 발송’이 꺼져 있어 아무것도 보내지 않습니다");
    return Promise.resolve();
  }
  // 미결 조회가 실패한 스캔의 요금제 유지 항목: 유지일이 틀렸을 수 있어(중복 1단계 문자) 보류.
  if (isDegraded(item)) {
    toast("폰클 미결 조회 실패로 요금제 유지 시점이 확실하지 않은 고객입니다 — 다시 스캔한 뒤 보내세요", { err: true });
    return Promise.resolve();
  }
  // 휴대폰 날짜가 틀리면 D-day/{when}/대상 판정이 모두 틀린다 (#58).
  if (clockBlocksSend(item)) return Promise.resolve();
  return openConfirm(item, opts); // 확인 모달에서 템플릿 선택/편집 후 발송
}

/* ---------- confirm send modal (템플릿 선택 + 편집 + 발송) ---------- */
let confirmItem: DueItem | null = null;
/** Record source override for the open sheet (see ConfirmOptions.recordSource). */
let confirmSource: RecordSource | undefined;
const MANUAL_TEMPLATE = "__manual__";
/** Dedup keys (phone|expiry) whose SMS is currently in flight — blocks a
 *  concurrent duplicate send of the same customer from another entry point. */
const sendingKeys = new Set<string>();

/** The text a template rendered into the box, when that template needs the 개통일
 *  ({months}/{years}) and this customer has none — sending it untouched would say
 *  "1개월 전 개통". Null when the box isn't such a render. */
let confirmOpendateGuard: string | null = null;
/** Bumped per openConfirm, so a slower (awaited) earlier open can't fill the sheet. */
let confirmSeq = 0;

/** A screen change drops a send sheet still being prepared (L27): it must not pop
 *  up over the screen the user moved to. An already open sheet is left alone. */
export function cancelPendingConfirm(): void {
  confirmSeq++;
}

/** Fill the confirm body from a template id, or leave it as-is (직접 입력). */
function applyConfirmTemplate(item: DueItem, id: string): void {
  if (id === MANUAL_TEMPLATE) { confirmOpendateGuard = null; return; } // 직접 입력: keep whatever's typed
  const tpl = (S.CFG.templates || []).find((t) => t.id === id);
  if (!tpl) return;
  const text = renderTemplate(item, tpl.body);
  $<HTMLTextAreaElement>("#confirm-text").value = text;
  confirmOpendateGuard = !hasKnownOpendate(item) && templateNeedsOpendate(tpl.body) ? text : null;
  updateConfirmLength();
}

/** The 글자수/단문·장문 line under the send textarea (#61). */
function updateConfirmLength(): void {
  $("#confirm-len").textContent = smsLengthLabel(smsLengthInfo($<HTMLTextAreaElement>("#confirm-text").value));
}

/** A real send to the same number within this many days is flagged on the confirm
 *  sheet even when its record can't be tied to this contract (older = previous contract). */
const RECENT_SAME_PHONE_DAYS = 90;

/** "YYYY-MM-DD" of a record's send time. */
function recDay(r: SentRecord): string {
  return String(r.sent_at || "").slice(0, 10) || "날짜 미상";
}

/**
 * The 안내 이력 note shown on the confirm sheet (3-3): this customer's own record
 * (phone|expiry), else a real send to the SAME NUMBER under another expiry (the key
 * drifted — 유지일/약정 개월 변경). `resend` = a counted send exists (button 재발송).
 */
function priorSendNote(item: DueItem, rec: SentRecord | null, all: SentRecord[]): { text: string; resend: boolean } | null {
  if (rec) {
    const state = sentStateOf(rec);
    if (state === "sent") return { text: `이미 ${recDay(rec)} 발송됨 — 보내면 같은 고객에게 한 번 더 나갑니다`, resend: true };
    if (state === "skipped") return { text: `${recDay(rec)} 처리됨(제외)으로 표시된 고객입니다`, resend: false };
    if (state === "failed") return { text: `${recDay(rec)} 발송 실패 — ${rec.fail_reason || "다시 보내 주세요"}`, resend: false };
    if (state === "recorded") return { text: `${recDay(rec)} 기록만 됨(실제 문자는 안 나감)`, resend: false };
  }
  const digits = normalizePhone(item.phone);
  if (!digits) return null;
  const since = toIso(addDays(today(), -RECENT_SAME_PHONE_DAYS));
  const other = all
    .filter((r) => countsAsSent(r) && normalizePhone(r.phone) === digits && r.expiry_date !== item.expiry_date
      && recDay(r) >= since)
    .sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1))[0];
  if (!other) return null;
  return { text: `이 번호로 ${recDay(other)}에 보낸 문자가 있습니다 (만료 ${other.expiry_date} 건) — 같은 안내인지 확인하세요`, resend: false };
}

async function openConfirm(item: DueItem, opts: ConfirmOptions = {}): Promise<void> {
  const seq = ++confirmSeq;
  let note: { text: string; resend: boolean } | null = null;
  if (!item.test) {
    try {
      const rec = await findPrevRecord(item, opts.recordSource === "manual");
      note = priorSendNote(item, rec, rec ? [] : await history.exportAll());
    } catch {
      note = null; // a storage glitch must not block the sheet; the send path re-checks
    }
  }
  if (seq !== confirmSeq) return; // a newer open superseded this one
  confirmItem = item;
  confirmSource = opts.recordSource;
  $("#confirm-name").textContent = item.customer || "-";
  $("#confirm-phone").textContent = item.phone;
  const prior = $("#confirm-prior");
  prior.textContent = note?.text ?? "";
  prior.classList.toggle("hidden", !note);
  const templates = S.CFG.templates || [];
  // Default = the auto-matched (시점-routed) template; else 직접 입력.
  const matched = opts.noAutoTemplate ? undefined : matchingTemplates(item, templates)[0];
  const sel = $<HTMLSelectElement>("#confirm-template");
  sel.innerHTML =
    templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name) || "(이름 없음)"}</option>`).join("") +
    `<option value="${MANUAL_TEMPLATE}">직접 입력</option>`;
  // Start clean every open: a matched template overwrites this; a MANUAL default
  // stays empty (never leaves the PREVIOUS customer's message in the box).
  $<HTMLTextAreaElement>("#confirm-text").value = "";
  confirmOpendateGuard = null;
  sel.value = matched?.id ?? MANUAL_TEMPLATE;
  applyConfirmTemplate(item, sel.value);
  updateConfirmLength();
  sel.onchange = () => applyConfirmTemplate(item, sel.value);
  const send = $<HTMLButtonElement>("#confirm-send");
  send.disabled = false;
  const delivering = S.CFG.deliver_alerts || item.test;
  send.textContent = !delivering ? "기록" : note?.resend ? "재발송" : "보내기";
  // 취소 first (like the in-app confirm): no stray Enter sends, no keyboard pop-up (I13).
  openModal($("#confirm-modal"), $("#confirm-cancel"));
}

/** Every SMS hand-off of this session (customer + test), for Android's 30-in-30-min
 *  bulk-send confirm (I2). */
const SMS_VOLUME = new SendVolumeMeter();

/** Count one SMS hand-off by its parts (Android counts each part of a long text,
 *  estimated like SmsPlugin's divideMessage); at ~25 parts within 30 min tell the
 *  staff member that the system confirm is coming and to press 허용 (once per
 *  burst). Never blocks. */
export function noteSmsHandOff(text: string): void {
  const notice = SMS_VOLUME.record(Date.now(), smsLengthInfo(text).segments);
  if (notice) void appAlert(notice, { title: "문자 대량 발송 안내" }).catch(() => undefined);
}

/**
 * 확인 모달을 바로 닫고 발송한다. 발송 성공(네이티브가 SmsManager 인계에 성공) 직후
 * 이력에 기록하고 홈/캐시를 갱신한다. 발송이 즉시 실패하면 기록하지 않는다.
 */
async function doConfirmSend(): Promise<void> {
  const item = confirmItem;
  const source = confirmSource;
  const manual = source === "manual";
  if (!item || $("#confirm-modal").classList.contains("hidden")) return; // stale/double tap
  const raw = $<HTMLTextAreaElement>("#confirm-text").value;
  const text = raw.trim();
  if (!text) { toast("보낼 내용을 입력하세요", { err: true }); return; }
  // 개통일을 모르는 고객에게 {경과개월}/{경과년수} 템플릿을 그대로 보내면 "1개월 전 개통"이
  // 된다 — 직원이 문구를 고칠 때까지 막는다(시트는 열어 둔다).
  if ((confirmOpendateGuard !== null && raw === confirmOpendateGuard) ||
      (!item.test && !hasKnownOpendate(item) && raw.includes(OPENDATE_MISSING_MARK))) {
    toast("개통일을 알 수 없어 {경과개월}이 들어간 문구는 보낼 수 없습니다 — 문구를 수정하세요", { err: true });
    return;
  }
  // 유선번호·이어붙은 번호는 문자를 받을 수 없다 — 보내기 전에 막는다 (#40). 기록 전용은 보내지 않으니 통과.
  if ((item.test || S.CFG.deliver_alerts) && !isValidKrMobile(item.phone)) {
    toast(`${INVALID_NUMBER_MESSAGE} — ${item.phone || "번호 없음"}`, { err: true });
    return;
  }
  // The sheet may have opened before a scan/probe found the phone's date wrong (#58).
  if (clockBlocksSend(item)) return;
  closeModal($("#confirm-modal"));
  confirmItem = null;
  confirmSource = undefined;
  confirmOpendateGuard = null;

  // Test row: never recorded (re-sendable). Its async outcome still surfaces.
  if (item.test) {
    toast("테스트 문자를 보냅니다");
    sendSmsTracked(item.phone, text).then(
      (id) => { if (id) TEST_SMS_IDS.add(id); noteSmsHandOff(text); scheduleResultChecks(id); },
      (e) => toast(e instanceof Error ? e.message : "발송 실패", { err: true }),
    );
    return;
  }

  // In-flight 가드는 양 모드(실제 발송/기록 전용) 공통으로 잡는다 — 같은 고객에 대한
  // 동시 처리(모드 전환 중 겹침 포함)를 막고, 아래 getRecord(prev) 읽기가 다른 발송의
  // 쓰기와 겹치지 않도록 보장한다.
  const key = `${item.phone}|${item.expiry_date}${manual ? "|manual" : ""}`;
  if (sendingKeys.has(key)) { toast("이미 처리 중입니다"); return; } // 중복 처리 방지
  sendingKeys.add(key);

  // 재발송이면 기존 안내 이력을 이번 발송으로 업데이트(upsert). prev = 직전 기록(있으면) —
  // 확인창과 같은 기준(같은 계약의 다른 만료일 기록 포함, B9)으로 찾는다.
  // 읽기 실패 시 가드를 풀어야 한다 — 안 그러면 앱 재시작 전까지 이 고객은 계속 '처리 중'.
  let prev: SentRecord | null;
  try {
    prev = await findPrevRecord(item, manual);
  } catch {
    sendingKeys.delete(key);
    toast("이력을 읽지 못했습니다 — 다시 시도하세요", { err: true });
    return;
  }
  const rec: SentRecord = {
    ...dueItemToEntry(item, text, source),
    // Upsert under the EXISTING record's key (B9): a drifted expiry (약정 개월 /
    // 유지일 changed) must not split one customer's history into two records.
    ...(prev ? { expiry_date: prev.expiry_date } : {}),
    channel: S.CFG.deliver_alerts ? "sms" : "record-only",
    sent_at: nowIso(),
  };

  // Record-only mode (실제 발송 꺼짐): 기록/업데이트만, 문자 안 보냄.
  if (!S.CFG.deliver_alerts) {
    // A real SMS record (sent OR reported failed) is never overwritten by a practice
    // record: that would erase the actual send's evidence (channel/sent_at/body).
    if (prev && prev.channel === "sms") {
      sendingKeys.delete(key);
      toast(countsAsSent(prev)
        ? "이미 문자를 보낸 고객입니다 — 다시 보내려면 ‘실제 발송’을 켜세요"
        : "실제 발송 기록(발송 실패)이 있는 고객입니다 — ‘실제 발송’을 켜고 다시 보내세요");
      return;
    }
    try {
      if (!(await history.putRecord(rec))) {
        sendingKeys.delete(key);
        toast("실제 발송 기록이 있는 고객이라 연습 기록으로 덮어쓰지 않았습니다");
        return;
      }
    } catch {
      sendingKeys.delete(key);
      toast("기록 저장에 실패했습니다 — 다시 시도하세요", { err: true });
      return;
    }
    try {
      await markHandled(item, manual);
      await history.cacheDueList(S.RESULTS);
    } catch {
      sendingKeys.delete(key);
      toast("기록은 저장했지만 대상 목록 갱신에 실패했습니다 — 다시 스캔하세요", { err: true });
      return;
    }
    sendingKeys.delete(key);
    toast(prev ? "안내 이력을 업데이트했습니다 (미발송)" : "기록되었습니다 (실제 발송 꺼짐)");
    return;
  }

  // Deliver ON — send FIRST, record right after the native layer accepts the SMS.
  // Recording before the send could leave a "발송됨" record for a message that never
  // went out (customer silently dropped from every future scan). The native send()
  // resolves at hand-off to SmsManager (milliseconds), NOT after the carrier's
  // delivery report, so the send→record gap is too short for the app to be killed
  // in between (a long wait there used to lose the record while the SMS still left).
  // The native layer rejects up front when the phone can't send at all (비행기 모드,
  // 유심 없음, 기본 SIM 미지정); a later radio failure arrives via reconcileSendResults
  // and flips this record to 'failed' by its sms_id.
  toast("문자 보내는 중…");
  let smsId: string;
  try {
    smsId = await sendSmsTracked(item.phone, text);
  } catch (e) {
    sendingKeys.delete(key);
    const msg = e instanceof Error ? e.message : "발송 실패";
    toast(`${item.customer || item.phone} 발송 실패 — ${msg}`, { err: true });
    void maybeOfferSmsSettings(msg); // 권한 거부면 설정 열기 안내
    return; // 고객은 홈에 미발송으로 그대로 남는다
  }
  if (smsId) INFLIGHT_SMS_IDS.add(smsId); // hold its result until the record exists
  noteSmsHandOff(text); // I2: the OS bulk-send confirm is near
  try {
    // 신규면 insert, 재발송/연습 기록이면 실제 발송(sms)으로 update. 실제로 보낸 고객에게
    // 재발송하면 이전 발송을 prev_sent로 보관 — 재발송이 실패하면 그 발송으로 되돌린다
    // (실패 하나로 이전 발송 기록이 사라져 고객이 미발송으로 되살아나지 않도록).
    await history.putRecord(withResendBackup(smsId ? { ...rec, sms_id: smsId } : rec, prev));
  } catch {
    // 문자는 나갔지만 이력 저장 실패 — 다음 스캔에서 중복 발송될 수 있으니 알린다.
    sendingKeys.delete(key);
    INFLIGHT_SMS_IDS.delete(smsId);
    toast("문자는 보냈지만 이력 저장에 실패했습니다 — 다음 스캔에서 중복 발송에 주의하세요", { err: true });
    return;
  }
  sendingKeys.delete(key);
  INFLIGHT_SMS_IDS.delete(smsId);
  scheduleResultChecks(smsId); // the record exists: its async outcome can now apply
  try {
    await markHandled(item, manual);
    await history.cacheDueList(S.RESULTS);
  } catch {
    // 이력(중복 방지 기준)은 저장됐다 — 화면/캐시만 낡았으니 그 사실만 알린다.
    toast("문자를 보내고 이력에도 저장했지만 대상 목록 갱신에 실패했습니다 — 다시 스캔하세요", { err: true });
    return;
  }
  toast(prev && countsAsSent(prev) ? "다시 보냈습니다 (안내 이력 업데이트)" : "문자를 보냈습니다");
}

/** When a send/permission failure was a permission denial, offer to jump to the app
 *  settings so the user can re-enable a permanently-denied SEND_SMS (the OS stops
 *  showing the request dialog once "다시 묻지 않음"). No-op for other failures. */
export async function maybeOfferSmsSettings(reason: string): Promise<void> {
  if (!/권한/.test(reason)) return;
  const go = await appConfirm("문자 발송 권한이 꺼져 있습니다.\n설정 화면에서 SMS 권한을 켜시겠어요?", {
    title: "문자 권한",
    okLabel: "설정 열기",
  });
  if (!go) return;
  try {
    await openAppSettings();
  } catch {
    toast("설정 화면을 열 수 없습니다", { err: true });
  }
}

/** Confirm-send sheet buttons. */
export function bindConfirmSheet(): void {
  // Confirm-send modal
  $("#confirm-cancel").onclick = () => { closeModal($("#confirm-modal")); confirmItem = null; confirmSource = undefined; };
  $("#confirm-send").onclick = () => void doConfirmSend();
  $("#confirm-text").addEventListener("input", () => updateConfirmLength());
}
