/**
 * 설정 > 데이터: CSV export, backup file share and restore-from-file.
 */
import { Share } from "@capacitor/share";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { droppedFieldLabels, restoreConfig, saveConfig } from "../domain/config";
import { buildBackup, classifyShareError, historyToCsv, parseBackup, type Backup } from "../domain/export";
import { appAlert, appConfirm } from "../ui/dialog";
import { requestSmsPermission } from "../native/adapters";
import { maybeOfferSmsSettings } from "./send";
import { backupWasSaved, capacitorCacheFs, purgeExportFiles, removeExportFile, type ShareOutcome } from "../ui/export-files";
import { restoreSummary, restoreSummaryInput } from "../ui/restore-summary";
import { applyRestoredExtras, restoredExtrasNote } from "../ui/restore-extras";
import { history, S } from "../app/state";
import { $, nowIso, toast, todayIsoLocal } from "../app/dom";
import { reconcileSentFlags } from "../app/sent-state";
import { renderDueList } from "./home";
import { populateSettings } from "./settings";

/* ---------- export / backup ---------- */
// ShareOutcome: "cancelled" is AMBIGUOUS (B4): @capacitor/share also rejects as
// cancelled when a dialog-style target (Quick Share, Bluetooth, 드라이브 저장)
// returned without finishing the activity — the file may well be on its way. Only
// "failed" means it was never handed over.

/**
 * Open the share sheet once. No fallback text share and no clipboard copy — the
 * payload is customer data (이름·번호·문자 원문) and must not leak to a second share
 * sheet or the clipboard. 'Share unavailable' (web preview) only toasts.
 */
async function shareOnce(
  opts: { title: string; text?: string; url?: string; dialogTitle: string },
  what: string,
  quietCancel = false,
): Promise<ShareOutcome> {
  try {
    await Share.share(opts);
    return "shared";
  } catch (e) {
    const kind = classifyShareError(e);
    if (kind === "cancelled") {
      // Gentle: never an error toast, and the file stays for the receiver (B4).
      // `quietCancel`: the caller asks the user instead (backup).
      if (!quietCancel) toast(`${what} 공유가 취소됐거나 완료를 확인하지 못했습니다 — 저장했다면 그대로 쓰시면 됩니다`);
      return "cancelled";
    }
    if (kind === "unavailable") toast("이 기기에서는 공유 기능을 사용할 수 없습니다", { err: true });
    else toast(`${what} 공유에 실패했습니다 — 다시 시도하세요`, { err: true });
    return "failed";
  }
}

/** Write an export file to the cache after removing EARLIER exports (B4: their
 *  cleanup is deferred to the next start / next export, never right after an
 *  ambiguous 'cancel'). Resolves the file uri. */
async function writeExportFile(fname: string, data: string): Promise<string> {
  await purgeExportFiles(capacitorCacheFs(), fname);
  const { uri } = await Filesystem.writeFile({ path: fname, data, directory: Directory.Cache, encoding: Encoding.UTF8 });
  return uri;
}
async function exportCsv(): Promise<void> {
  const rows = await history.exportAll();
  if (rows.length === 0) { toast("내보낼 이력이 없습니다"); return; }
  const title = "발송 이력 (CSV)";
  const fname = `poncle-history-${todayIsoLocal()}.csv`;
  let uri: string;
  try {
    // 실제 .csv 파일(UTF-8 BOM 포함)로 저장한 뒤 그 파일을 공유 → Excel에서 바로 열린다 (3-6).
    uri = await writeExportFile(fname, historyToCsv(rows));
  } catch {
    toast("CSV 파일을 만들지 못했습니다 — 다시 시도하세요", { err: true });
    return;
  }
  const outcome = await shareOnce({ title, url: uri, dialogTitle: title }, "이력 CSV");
  // PII on disk (L6): a definite failure -> delete now; shared or an ambiguous
  // cancel (B4) -> the receiver may still be reading it: the next start/export purges it.
  if (outcome === "failed") await removeExportFile(capacitorCacheFs(), fname);
}
async function exportBackup(): Promise<void> {
  // 미방문 수동 제외 + 재방문 코호트도 함께 (#55) — 새 폰에서 제외한 고객이 되살아나지 않게.
  const backup = buildBackup(S.CFG, await history.exportAll(), nowIso(), {
    excluded: await history.handledKeys(),
    cohort: await history.loadCohort(),
  });
  const json = JSON.stringify(backup, null, 2);
  const fname = `poncle-backup-${todayIsoLocal()}.json`;
  let uri: string;
  try {
    // 실제 .json 파일로 저장한 뒤 그 파일을 공유(→ 새 폰에서 '파일 가져오기'로 복원).
    uri = await writeExportFile(fname, json);
  } catch {
    toast("백업 파일을 만들지 못했습니다 — 다시 시도하세요", { err: true });
    return;
  }
  const outcome = await shareOnce({ title: "약정만료 알리미 백업", url: uri, dialogTitle: "백업 파일 저장/공유" }, "백업", true);
  if (outcome === "failed") {
    // 확실한 실패: 백업한 것으로 기록하지 않고 파일도 바로 지운다(L6).
    await removeExportFile(capacitorCacheFs(), fname);
    return;
  }
  // 모호한 '취소'(B4): Quick Share·Bluetooth·드라이브 저장은 실제로 받았어도 '취소'로
  // 끝난다. 파일은 다음 시작/다음 내보내기 때 지우고(전송 중일 수 있음), 백업일은
  // 사용자에게 물어 기록한다 — 대시보드 '백업 필요'가 계속 뜨지 않게.
  const saved = await backupWasSaved(outcome, () =>
    appConfirm("백업 파일을 저장하거나 보냈나요?\n\nQuick Share, 블루투스, 드라이브 저장은 완료돼도 '취소'로 표시될 수 있습니다.", {
      title: "백업 확인",
      okLabel: "저장했어요",
      cancelLabel: "아니요",
    }),
  );
  if (!saved) {
    if (outcome === "cancelled") toast("백업이 기록되지 않았습니다 — 저장하지 못했다면 다시 백업하세요");
    return;
  }
  // 공유 완료(또는 사용자 확인): 대시보드 백업 리마인더 기준.
  await history.setLastBackup(nowIso());
  toast(outcome === "shared" ? "백업 파일을 공유했습니다 — 저장했는지 확인하세요" : "백업을 기록했습니다");
}
/** Import a backup from a picked .json file (replaces paste-JSON restore). Reading
 *  or parsing the file and SAVING the restore fail with different messages (U4):
 *  '파일을 읽지 못했습니다' only when the file itself was the problem. */
async function restoreFromFile(input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  const msg = $("#backup-msg");
  if (!file) return;
  try {
    let backup: Backup | null;
    try {
      backup = parseBackup(await file.text());
    } catch {
      msg.textContent = "파일을 읽지 못했습니다";
      toast("파일을 읽지 못했습니다", { err: true });
      return;
    }
    if (!backup) { msg.textContent = "백업 파일 형식이 아닙니다"; toast("백업 형식이 아닙니다", { err: true }); return; }
    // Restore MERGES by customer key (phone|expiry): nothing on this phone is lost and
    // a real send is never downgraded by the file's practice/failed record. It ALWAYS
    // asks first with what changes (B16/I9): backup date, history counts (real sends
    // among them, and how many of this phone's customers the file lacks — compared
    // by key, not count), the template replacement and the 실제 발송 switch.
    let ok: boolean;
    try {
      const current = await history.exportAll();
      const restored = backup.config ? restoreConfig(backup.config, S.CFG, { templateSchema: backup.template_schema }).config : null;
      const summary = restoreSummary(restoreSummaryInput({ backup, current, cfg: S.CFG, restored }));
      ok = await appConfirm(summary.message, { title: "백업 복원", okLabel: summary.okLabel });
    } catch {
      msg.textContent = "이 기기의 발송 이력을 읽지 못해 복원하지 않았습니다";
      toast("이 기기의 발송 이력을 읽지 못했습니다 — 다시 시도하세요", { err: true });
      return;
    }
    if (!ok) { msg.textContent = "복원을 취소했습니다"; toast("복원 취소됨"); return; }
    await applyRestore(backup, msg);
  } finally {
    input.value = ""; // 같은 파일을 다시 고를 수 있도록 초기화
  }
}

/** Merge the confirmed backup into this phone. A storage failure here is a SAVE
 *  error, not a bad file (U4): the merge is idempotent, so importing the same file
 *  again finishes it. */
async function applyRestore(backup: Backup, msg: HTMLElement): Promise<void> {
  let merge: { added: number; kept: number };
  let extrasNote = "";
  let skipped: string[] = [];
  const deliverWasOn = !!S.CFG.deliver_alerts;
  try {
    // Merged against the log as it is NOW, inside the history lock (B6, contract C2):
    // a send result or 재발송 that landed while the confirm was open is kept.
    merge = await history.mergeRestore(backup.history);
    // 미방문 제외(합집합) + 재방문 코호트(고객별 병합)도 합친다 (#55).
    extrasNote = restoredExtrasNote(await applyRestoredExtras(history, backup));
    // Restored settings: each field type-checked (#41 — a wrong-typed one keeps this
    // phone's value), template migration (no retired defaults) + this phone's own
    // test number. Re-derived from the CURRENT config (it may have changed while the
    // confirm was up).
    if (backup.config) {
      const latest = restoreConfig(backup.config, S.CFG, { templateSchema: backup.template_schema });
      S.CFG = await saveConfig(latest.config);
      S.CONFIG_READ_FAILED = false; // a full config is stored again
      skipped = latest.dropped;
    }
  } catch {
    msg.textContent = "복원 중 저장에 실패했습니다 — 같은 파일로 다시 가져오기를 해 주세요";
    toast("복원 중 저장에 실패했습니다 — 같은 파일을 다시 가져오세요 (이미 반영된 내용은 중복되지 않습니다)", { err: true });
    await refreshAfterRestore().catch(() => undefined);
    return;
  }
  // Re-fill the form so leaving 설정 can't save stale values over it; the home list
  // + cache must reflect the restored sends right away (no re-send).
  try {
    await refreshAfterRestore();
  } catch {
    toast("복원했지만 대상 목록 갱신에 실패했습니다 — 다시 스캔하세요", { err: true });
  }
  const skipNote = skipped.length
    ? ` — 형식이 잘못된 설정 ${skipped.length}개는 건너뛰었습니다 (${droppedFieldLabels(skipped).join(", ")})`
    : "";
  msg.textContent = `복원됨 (이력 ${merge.added + merge.kept}건, 새로 추가 ${merge.added}건${extrasNote})${skipNote}`;
  toast(`복원되었습니다${skipNote}`, skipped.length ? { err: true } : {});
  // Not awaited: the restore is done; this notice must not turn into an error.
  if (!deliverWasOn && S.CFG.deliver_alerts) void onRestoreTurnedDeliveryOn(msg).catch(() => undefined);
}

async function refreshAfterRestore(): Promise<void> {
  populateSettings();
  await reconcileSentFlags();
  await history.cacheDueList(S.RESULTS);
  renderDueList();
}

/** The restore switched 실제 발송 ON (L22): say that customers now get real texts and
 *  ask for the SMS permission right away, not only at the first send. */
async function onRestoreTurnedDeliveryOn(msg: HTMLElement): Promise<void> {
  msg.textContent += " · 실제 발송이 켜졌습니다 — 이제 고객에게 실제 문자가 나갑니다";
  await appAlert("백업 설정에 따라 ‘실제 발송’이 켜졌습니다.\n이제 고객에게 실제 문자가 나갑니다. 연습만 하려면 설정에서 끄세요.", {
    title: "실제 발송 켜짐",
  });
  const granted = await requestSmsPermission().catch(() => false);
  if (!granted) await maybeOfferSmsSettings("SMS 권한");
}

/** Backup / export buttons. */
export function bindBackup(): void {
  // Backup / export
  $("#btn-export-csv").onclick = () => void exportCsv();
  $("#btn-export-backup").onclick = () => void exportBackup();
  $("#btn-restore-file").onclick = () => $<HTMLInputElement>("#restore-file").click();
  $<HTMLInputElement>("#restore-file").addEventListener("change", (e) => void restoreFromFile(e.target as HTMLInputElement));
}
