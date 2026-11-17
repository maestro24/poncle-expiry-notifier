/**
 * B16 / I9: the restore confirm is ALWAYS shown, with what the file will change —
 * backup date, history counts (merged, nothing on this phone is lost), template
 * replacement and the 실제 발송 switch — so templates/settings are never swapped
 * silently.
 */
import { missingFromBackup } from "../domain/export";
import { countsAsSent, type SentRecord } from "../domain/history";
import type { AppConfig } from "../domain/types";

export interface RestoreSummaryInput {
  /** Backup's exported_at (ISO local datetime, "" when unknown). */
  exportedAt: string;
  backupHistory: number;
  /** Of backupHistory, real SMS sends not reported failed (countsAsSent). Optional
   *  for callers built before I9. */
  backupSent?: number;
  currentHistory: number;
  /** Customers this phone has that the file lacks (kept by the merge). */
  missing: number;
  templatesBefore: number;
  /** Template count after the restore; null = the file carries no settings. */
  templatesAfter: number | null;
  /** The restored template list differs from this phone's. */
  templatesChanged: boolean;
  deliverBefore: boolean;
  /** 실제 발송 after the restore; null = the file carries no settings. */
  deliverAfter: boolean | null;
}

/** What restoreSummaryInput reads from the parsed backup. */
export interface RestoreBackupView {
  exported_at: string;
  history: readonly SentRecord[];
}

/**
 * The summary facts from the backup and this phone (I9), through the domain's own
 * rules: missingFromBackup (by customer key) and countsAsSent (real sends).
 * `restored` = restoreConfig(backup.config, cfg).config, or null when the file
 * carries no settings.
 */
export function restoreSummaryInput(a: {
  backup: RestoreBackupView;
  current: readonly SentRecord[];
  cfg: AppConfig;
  restored: AppConfig | null;
}): RestoreSummaryInput {
  const { backup, current, cfg, restored } = a;
  const before = cfg.templates ?? [];
  const after = restored ? restored.templates ?? [] : null;
  return {
    exportedAt: backup.exported_at,
    backupHistory: backup.history.length,
    backupSent: backup.history.filter(countsAsSent).length,
    currentHistory: current.length,
    missing: missingFromBackup(current, backup.history),
    templatesBefore: before.length,
    templatesAfter: after ? after.length : null,
    templatesChanged: !!after && JSON.stringify(after) !== JSON.stringify(before),
    deliverBefore: !!cfg.deliver_alerts,
    deliverAfter: restored ? !!restored.deliver_alerts : null,
  };
}

export interface RestoreSummary {
  message: string;
  okLabel: string;
}

const onOff = (v: boolean): string => (v ? "켜짐" : "꺼짐");

function backupDate(iso: string): string {
  const s = String(iso || "").trim();
  if (!s) return "알 수 없음";
  return s.replace("T", " ").slice(0, 16);
}

export function restoreSummary(i: RestoreSummaryInput): RestoreSummary {
  const lines: string[] = [
    `백업 날짜: ${backupDate(i.exportedAt)}`,
    `발송 이력: 백업 파일 ${i.backupHistory}건 · 이 기기 ${i.currentHistory}건 (합쳐서 복원)`,
  ];
  if (i.backupSent !== undefined) {
    lines.push(`백업 파일 중 실제로 보낸 문자 ${i.backupSent}건 (나머지는 기록만·제외·발송 실패)`);
  }
  if (i.missing > 0) {
    lines.push(`이 기기의 발송 이력 중 ${i.missing}명의 기록이 백업 파일에 없습니다 — 다른 기기나 오래된 백업 파일일 수 있습니다. 이 기기 기록은 그대로 남깁니다.`);
  }
  if (i.templatesAfter === null || i.deliverAfter === null) {
    lines.push("설정·템플릿: 백업 파일에 없어 그대로 둡니다");
  } else {
    lines.push(i.templatesChanged
      ? `템플릿: ${i.templatesBefore}개 → ${i.templatesAfter}개 (백업 파일의 템플릿으로 바뀝니다)`
      : `템플릿: 그대로 (${i.templatesBefore}개)`);
    lines.push(i.deliverAfter !== i.deliverBefore
      ? `실제 발송: ${onOff(i.deliverBefore)} → ${onOff(i.deliverAfter)}${i.deliverAfter ? "" : " (문자가 나가지 않고 기록만 됩니다)"}`
      : `실제 발송: 그대로 (${onOff(i.deliverBefore)})`);
  }
  return {
    message: `${lines.join("\n")}\n\n복원할까요?`,
    okLabel: i.missing > 0 ? "합쳐서 복원" : "복원",
  };
}
