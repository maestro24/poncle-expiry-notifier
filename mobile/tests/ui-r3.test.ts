// @vitest-environment happy-dom
/**
 * Stage R3 UI helpers: the SMS bulk-send notice (I2), the catch-up cap notice
 * (I3), the 조회 client-side filter (I5), the send-failure toast (I6), the template
 * variable chips (I8), the restore summary input (I9), the 이력 search debounce +
 * seq guard (I10), the send-log size warning (I12), modal focus handling (I13) and
 * the auto update-check backoff (U8).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDate } from "../src/domain/plaindate";
import type { SentRecord } from "../src/domain/history";
import type { AppConfig } from "../src/domain/types";
import { DEFAULTS } from "../src/domain/config";
import { SMS_VOLUME_WARN_AT, SendVolumeMeter } from "../src/ui/send-volume";
import { catchUpCapNotice } from "../src/ui/catchup-notice";
import { LOOKUP_IGNORED_TITLE, applyLookupQuery } from "../src/ui/lookup-filter";
import { sendFailureNotice } from "../src/ui/send-failure";
import { templateVarChips } from "../src/ui/var-chips";
import { restoreSummary, restoreSummaryInput } from "../src/ui/restore-summary";
import { SeqGuard, debounce } from "../src/ui/debounce";
import { HISTORY_SIZE_WARN_BYTES, historySizeWarning, utf8Bytes } from "../src/ui/history-size";
import { closeModal, openModal } from "../src/ui/modal";
import { UPDATE_BACKOFF_MAX_MS, updateRetryDelayMs } from "../src/ui/update-backoff";

const MIN = 60_000;

describe("SendVolumeMeter (I2: Android 30 SMS / 30 min)", () => {
  it("warns once when the 30-min count reaches the threshold, not before", () => {
    const m = new SendVolumeMeter();
    const t0 = Date.parse("2026-07-03T09:00:00");
    for (let i = 0; i < SMS_VOLUME_WARN_AT - 1; i++) expect(m.record(t0 + i * 1000)).toBeNull();
    const notice = m.record(t0 + 60_000);
    expect(notice).toContain(`${SMS_VOLUME_WARN_AT}건`);
    expect(notice).toContain("허용");
    // Further sends in the same burst: no repeat.
    expect(m.record(t0 + 61_000)).toBeNull();
    expect(m.record(t0 + 62_000)).toBeNull();
  });

  it("only counts sends inside the 30-minute window and re-arms after the burst ends", () => {
    const m = new SendVolumeMeter();
    const t0 = Date.parse("2026-07-03T09:00:00");
    for (let i = 0; i < SMS_VOLUME_WARN_AT; i++) m.record(t0 + i * 1000);
    expect(m.count(t0 + 30_000)).toBe(SMS_VOLUME_WARN_AT);
    // 31 minutes later the earlier sends no longer count.
    const later = t0 + 31 * MIN;
    expect(m.count(later)).toBe(0);
    for (let i = 0; i < SMS_VOLUME_WARN_AT - 1; i++) expect(m.record(later + i * 1000)).toBeNull();
    expect(m.record(later + 60_000)).toContain("허용"); // a new burst warns again
  });
});

describe("SendVolumeMeter counts SMS PARTS (review: Android counts each multipart part)", () => {
  it("a long text split into 5 parts adds 5 to the window", () => {
    const m = new SendVolumeMeter();
    const t0 = Date.parse("2026-07-03T09:00:00");
    expect(m.record(t0, 5)).toBeNull();
    expect(m.count(t0 + 1000)).toBe(5);
  });
  it("warns around the 5th send of a 5-part template, long before 25 sends", () => {
    const m = new SendVolumeMeter();
    const t0 = Date.parse("2026-07-03T09:00:00");
    for (let i = 0; i < 4; i++) expect(m.record(t0 + i * 1000, 5)).toBeNull(); // 20 parts
    const notice = m.record(t0 + 5000, 5); // 25 parts
    expect(notice).toContain("25건");
    expect(notice).toContain("분할");
    expect(notice).toContain("허용");
    expect(m.record(t0 + 6000, 5)).toBeNull(); // once per burst
  });
  it("a bad part count is treated as one part", () => {
    const m = new SendVolumeMeter();
    const t0 = Date.parse("2026-07-03T09:00:00");
    m.record(t0, 0);
    m.record(t0, Number.NaN);
    m.record(t0, 2.7);
    expect(m.count(t0)).toBe(4); // 1 + 1 + 2
  });
});

describe("catchUpCapNotice (I3)", () => {
  const today = makeDate(2026, 7, 20);
  it("null while the last clean scan is within the catch-up window", () => {
    expect(catchUpCapNotice("2026-07-10", today, { degraded: false })).toBeNull();
    expect(catchUpCapNotice("2026-07-06", today, { degraded: false })).toBeNull(); // exactly 14 days
    expect(catchUpCapNotice("", today, { degraded: false })).toBeNull();
    expect(catchUpCapNotice("garbage", today, { degraded: true })).toBeNull();
  });
  it("names the last clean scan day and the gap once it is longer than 14 days", () => {
    const n = catchUpCapNotice("2026-06-30", today, { degraded: false })!;
    expect(n).toContain("6월 30일");
    expect(n).toContain("20일");
    expect(n).toContain("14일");
  });
  it("says the 미결 failure keeps going when the capped scan was degraded", () => {
    expect(catchUpCapNotice("2026-06-30", today, { degraded: true })).toContain("미결");
  });
});

describe("applyLookupQuery (I5: the server ignored the search field)", () => {
  const rows = [
    { customer: "홍길동", phone: "010-1111-2222" },
    { customer: "김철수", phone: "010-3333-4444" },
  ];
  it("keeps only rows that contain the query (name or phone digits)", () => {
    expect(applyLookupQuery(rows, "홍길").rows.map((r) => r.customer)).toEqual(["홍길동"]);
    expect(applyLookupQuery(rows, "01033334444").rows.map((r) => r.customer)).toEqual(["김철수"]);
    expect(applyLookupQuery(rows, "3333-4444").rows.map((r) => r.customer)).toEqual(["김철수"]);
    expect(applyLookupQuery(rows, "홍 길동").rows.map((r) => r.customer)).toEqual(["홍길동"]);
    expect(applyLookupQuery(rows, "홍길동").ignored).toBe(false);
  });
  it("flags a non-empty server answer with no matching row as 'ignored'", () => {
    const r = applyLookupQuery(rows, "박영희");
    expect(r.rows).toEqual([]);
    expect(r.ignored).toBe(true);
    expect(LOOKUP_IGNORED_TITLE).toBe("검색 조건이 적용되지 않았습니다");
  });
  it("an empty server answer is a plain 'no match', not 'ignored'", () => {
    expect(applyLookupQuery([], "박영희")).toEqual({ rows: [], ignored: false });
  });
  it("keeps rows matching the phone the server was actually asked for (82… without '+')", () => {
    // searchFieldFor('821011112222') asks Poncle for openphone=01011112222.
    const r = applyLookupQuery(rows, "821011112222");
    expect(r.rows.map((x) => x.customer)).toEqual(["홍길동"]);
    expect(r.ignored).toBe(false);
    expect(applyLookupQuery(rows, "82 10 1111 2222").rows.map((x) => x.customer)).toEqual(["홍길동"]);
    expect(applyLookupQuery(rows, "+82 10-3333-4444").rows.map((x) => x.customer)).toEqual(["김철수"]);
  });
  it("an unrelated phone answer is still flagged as 'ignored'", () => {
    expect(applyLookupQuery(rows, "821099998888").ignored).toBe(true);
  });
});

const rec = (over: Partial<SentRecord>): SentRecord => ({
  phone: "010-1111-2222", customer: "홍길동", opendate: "24-07-03", expiry_date: "2026-07-03",
  telecom: "SKT", agency: "", model: "", plan: "", staff: "", channel: "sms", sent_at: "2026-07-03T09:00:00",
  ...over,
} as SentRecord);

describe("sendFailureNotice (I6)", () => {
  it("names the customer and the first failure reason", () => {
    const n = sendFailureNotice({ failed: [rec({ fail_reason: "유심이 없습니다" })], resendFailed: [], testFails: [] });
    expect(n.toast).toContain("홍길동");
    expect(n.toast).toContain("유심이 없습니다");
    expect(n.toast).toContain("다시 보내");
    expect(n.testMsg).toBeNull();
  });
  it("counts the others and decodes old HTML-escaped names; a nameless record falls back to the phone", () => {
    const n = sendFailureNotice({
      failed: [rec({ customer: "PS&amp;M", fail_reason: "비행기 모드" }), rec({ customer: "", phone: "010-9999-0000" })],
      resendFailed: [], testFails: [],
    });
    expect(n.toast).toContain("PS&M 외 1건");
    expect(n.toast).toContain("비행기 모드");
    const solo = sendFailureNotice({ failed: [rec({ customer: "" })], resendFailed: [], testFails: [] });
    expect(solo.toast).toContain("010-1111-2222");
  });
  it("a failed 재발송 keeps the earlier send and says so, with its reason", () => {
    const n = sendFailureNotice({ failed: [], resendFailed: [rec({ resend_fail_reason: "신호 없음" })], testFails: [] });
    expect(n.toast).toContain("재발송 실패");
    expect(n.toast).toContain("신호 없음");
    expect(n.toast).toContain("그대로 유지");
  });
  it("a test-send failure in the same batch as a real one is not hidden", () => {
    const n = sendFailureNotice({
      failed: [rec({ fail_reason: "유심이 없습니다" })], resendFailed: [],
      testFails: [{ id: "t1", status: "fail", reason: "권한 없음", at: "" }],
    });
    expect(n.toast).toContain("홍길동");
    expect(n.toast).toContain("테스트 문자");
    expect(n.testMsg).toBe("실패: 권한 없음");
  });
  it("test failure alone keeps the old message", () => {
    const n = sendFailureNotice({ failed: [], resendFailed: [], testFails: [{ id: "t1", status: "fail", at: "" }] });
    expect(n.toast).toBe("테스트 문자 발송 실패 — 발송 실패");
    expect(n.testMsg).toBe("실패: 발송 실패");
  });
  it("nothing failed -> nothing to say", () => {
    expect(sendFailureNotice({ failed: [], resendFailed: [], testFails: [] })).toEqual({ toast: null, testMsg: null });
  });
});

describe("templateVarChips (I8)", () => {
  it("chips insert the Korean token itself, in a fixed order", () => {
    const chips = templateVarChips({ 고객명: "customer", 통신사: "telecom", 만료일: "expiry" });
    expect(chips).toEqual([
      { label: "고객명", token: "{고객명}" },
      { label: "통신사", token: "{통신사}" },
      { label: "만료일", token: "{만료일}" },
    ]);
  });
  it("shows 전화번호 / 거래처 / 담당 once the renderer knows them, never a token it doesn't", () => {
    const labels = templateVarChips({ 고객명: "customer", 전화번호: "phone", 거래처: "agency", 담당: "staff" }).map((c) => c.label);
    expect(labels).toEqual(["고객명", "전화번호", "거래처", "담당"]);
    expect(templateVarChips({ 고객명: "customer" }).map((c) => c.label)).not.toContain("담당");
  });
  it("an alias outside the preferred order is still offered (after the known ones)", () => {
    expect(templateVarChips({ 고객명: "customer", 새변수: "x" }).map((c) => c.label)).toEqual(["고객명", "새변수"]);
  });
});

describe("restoreSummaryInput (I9)", () => {
  const cfg = (over: Partial<AppConfig> = {}): AppConfig => ({ ...DEFAULTS, ...over } as AppConfig);
  it("derives the summary from the backup and this phone, counting the file's real sends", () => {
    const backup = {
      exported_at: "2026-07-01T10:00:00",
      history: [
        rec({}),
        rec({ phone: "010-2222-3333", channel: "record-only" }),
        rec({ phone: "010-4444-5555", delivery: "failed", fail_reason: "x" }),
      ],
    };
    const current = [rec({}), rec({ phone: "010-7777-8888" })];
    const restored = cfg({ deliver_alerts: true, templates: [] });
    const input = restoreSummaryInput({ backup, current, cfg: cfg({ deliver_alerts: false }), restored });
    expect(input).toMatchObject({
      exportedAt: "2026-07-01T10:00:00",
      backupHistory: 3,
      backupSent: 1,
      currentHistory: 2,
      missing: 1,
      deliverBefore: false,
      deliverAfter: true,
      templatesAfter: 0,
    });
    expect(restoreSummary(input).message).toContain("실제로 보낸 문자 1건");
  });
  it("a file without settings leaves templates/delivery alone", () => {
    const input = restoreSummaryInput({ backup: { exported_at: "", history: [] }, current: [], cfg: cfg(), restored: null });
    expect(input.templatesAfter).toBeNull();
    expect(input.deliverAfter).toBeNull();
    expect(input.templatesChanged).toBe(false);
  });
});

describe("debounce + SeqGuard (I10)", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("runs once, with the last call, after the quiet period", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 250);
    d.call(); d.call(); d.call();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(249);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("cancel drops a pending call", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d.call();
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
  });
  it("SeqGuard: only the newest ticket is current", () => {
    const g = new SeqGuard();
    const a = g.next();
    const b = g.next();
    expect(g.isCurrent(a)).toBe(false);
    expect(g.isCurrent(b)).toBe(true);
    g.invalidate();
    expect(g.isCurrent(b)).toBe(false);
  });
});

describe("historySizeWarning (I12)", () => {
  it("counts UTF-8 bytes (Korean = 3 bytes)", () => {
    expect(utf8Bytes("ab")).toBe(2);
    expect(utf8Bytes("홍길동")).toBe(9);
  });
  it("silent below the threshold, a size in MB above it", () => {
    expect(historySizeWarning(HISTORY_SIZE_WARN_BYTES - 1)).toBeNull();
    const w = historySizeWarning(Math.round(2.5 * 1024 * 1024))!;
    expect(w).toContain("2.5MB");
    expect(w).toContain("백업");
  });
});

describe("openModal / closeModal (I13)", () => {
  function setup(): { overlay: HTMLElement; opener: HTMLButtonElement; first: HTMLButtonElement; last: HTMLButtonElement } {
    document.body.innerHTML = `
      <div id="wrap"><button id="opener">열기</button></div>
      <div id="m" class="modal-overlay hidden" role="dialog" aria-modal="true">
        <div class="modal"><button id="a">A</button><textarea id="t"></textarea><button id="b">B</button></div>
      </div>`;
    const opener = document.getElementById("opener") as HTMLButtonElement;
    opener.focus();
    return {
      overlay: document.getElementById("m")!,
      opener,
      first: document.getElementById("a") as HTMLButtonElement,
      last: document.getElementById("b") as HTMLButtonElement,
    };
  }
  it("shows the overlay, moves focus inside, and returns it to the opener on close", () => {
    const { overlay, opener, first } = setup();
    openModal(overlay);
    expect(overlay.classList.contains("hidden")).toBe(false);
    expect(document.activeElement).toBe(first);
    closeModal(overlay);
    expect(overlay.classList.contains("hidden")).toBe(true);
    expect(document.activeElement).toBe(opener);
  });
  it("focuses the requested element, and falls back to the opener's container when it was removed", () => {
    const { overlay, opener } = setup();
    const t = document.getElementById("t") as HTMLTextAreaElement;
    openModal(overlay, t);
    expect(document.activeElement).toBe(t);
    opener.remove();
    closeModal(overlay);
    expect(document.activeElement?.id).toBe("wrap");
  });
  it("Tab wraps inside the open modal", () => {
    const { overlay, first, last } = setup();
    openModal(overlay);
    last.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(first);
    first.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(last);
    closeModal(overlay);
  });
});

describe("updateRetryDelayMs (U8)", () => {
  it("no wait before the first failure, then doubles, capped at 6 hours", () => {
    expect(updateRetryDelayMs(0)).toBe(0);
    const d1 = updateRetryDelayMs(1);
    expect(d1).toBeGreaterThan(0);
    expect(updateRetryDelayMs(2)).toBe(d1 * 2);
    expect(updateRetryDelayMs(3)).toBe(d1 * 4);
    expect(updateRetryDelayMs(50)).toBe(UPDATE_BACKOFF_MAX_MS);
    expect(UPDATE_BACKOFF_MAX_MS).toBe(6 * 60 * MIN);
  });
});
