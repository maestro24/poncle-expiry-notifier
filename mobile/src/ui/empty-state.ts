/**
 * Empty-state and 기준일 copy (D2, B7). Pure: the screens pass the scan dates and
 * the '마지막 스캔' label ("M/D HH:MM", see dom.nowShort).
 */

/** "HH:MM" out of the 'M/D HH:MM' last-scan label ("" when it has none). */
export function lastScanClock(label: string): string {
  const m = /(\d{1,2}:\d{2})\s*$/.exec(String(label ?? ""));
  return m ? m[1] : "";
}

/** A successful scan today found nobody: say that (with the time), not "scan again". */
function nobodyToday(lastScan: string): string {
  const clock = lastScanClock(lastScan);
  return clock ? `오늘 안내할 대상이 없습니다 (마지막 스캔 ${clock})` : "오늘 안내할 대상이 없습니다";
}

export interface DueEmptyInput {
  /** The scan list has rows (the search/filter hid them all). */
  hasResults: boolean;
  /** ISO date of the scan behind the list ("" = never / unknown). */
  scanDateIso: string;
  todayIso: string;
  /** '마지막 스캔' label. */
  lastScan: string;
}

/** Home due-list empty line. */
export function dueEmptyText(i: DueEmptyInput): string {
  if (i.hasResults) return "검색/필터에 맞는 대상이 없습니다.";
  if (i.scanDateIso && i.scanDateIso === i.todayIso) return nobodyToday(i.lastScan);
  return "스캔 결과가 없습니다. “지금 다시 스캔”을 눌러 주세요.";
}

/** 대시보드 '통신사별 분포' empty line. */
export function carrierEmptyText(scanDateIso: string, todayIso: string, lastScan: string): string {
  return scanDateIso && scanDateIso === todayIso ? nobodyToday(lastScan) : "스캔 결과가 없습니다";
}

export interface BasisNote {
  text: string;
  /** Not from today's scan: shown as a warning. */
  stale: boolean;
}

/**
 * 미방문 tab 기준일 line (B7). The 미방문 cache moves only with a clean scan, so its
 * day is the last clean scan's. Null when nothing is known and nothing is listed.
 */
export function unvisitedBasisNote(cleanDateIso: string, todayIso: string, count: number): BasisNote | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cleanDateIso || "");
  if (!m) {
    return count > 0 ? { text: "이전에 저장된 스캔 기준입니다 — 그 사이 재방문한 고객이 있을 수 있어 지금 다시 스캔하세요", stale: true } : null;
  }
  if (cleanDateIso === todayIso) return { text: "오늘 스캔 기준입니다", stale: false };
  return {
    text: `${Number(m[2])}월 ${Number(m[3])}일 스캔 기준입니다 — 그 사이 재방문한 고객이 있을 수 있어 지금 다시 스캔하세요`,
    stale: true,
  };
}
