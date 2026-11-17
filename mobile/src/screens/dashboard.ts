/**
 * 대시보드 screen.
 */
import { cohortStats, COHORT_WINDOW_DAYS } from "../domain/cohort";
import { carrierBreakdown, sentTrend } from "../domain/dashboard";
import { today } from "../domain/plaindate";
import { history, S } from "../app/state";
import { hooks } from "../app/hooks";
import { $, esc, toast, todayIsoLocal, daysSince } from "../app/dom";
import { carrierEmptyText } from "../ui/empty-state";
import { dashboardSoon, unvisitedNotDue } from "../ui/dashboard-soon";
import { LK_WARN_ICON } from "../app/icons";
import { doScan } from "./scan";

/* ---------- dashboard (대시보드) ---------- */
export async function renderDashboard(): Promise<void> {
  const body = $("#dash-body");
  const todayD = today();
  const todayIso = todayIsoLocal();

  // S.RESULTS is the cached due list as restored at boot — D-days re-derived for
  // today, expired rows dropped, send state reconciled from the log — so the
  // dashboard never counts a practice record as sent or shows a stale D-day.
  const due = S.RESULTS.filter((r) => !r.test);
  const targets = due.length;
  const unsent = due.filter((r) => !r.already_sent).length;
  const cachedUnv = await history.loadUnvisited();
  // 수동 제외는 계약 단위로 매칭 (B8, contract C3) — 이력 탭 배지와 같은 수.
  const exclusions = await history.exclusionIndex(); // one read for the whole list
  // A customer on the due list (D+N catch-up) is counted there, not again as 미방문 (L24).
  const unvisitedCount = unvisitedNotDue(cachedUnv.filter((r) => !exclusions.isHandled(r)), due).length;

  // 임박 = still waiting for the 안내 (L24): unsent, D-3 … D+N within the catch-up window.
  const soon = dashboardSoon(due, todayD);

  const trend = sentTrend(await history.exportAll(), todayD, 7);
  const trendMax = Math.max(1, ...trend.map((d) => d.count));
  const carriers = carrierBreakdown(due);
  const carrierMax = Math.max(1, ...carriers.map((c) => c.count));
  const cohort = cohortStats(await history.loadCohort(), todayD, COHORT_WINDOW_DAYS);

  const lastBackup = await history.getLastBackup();
  const backupDays = lastBackup ? Math.max(0, daysSince(lastBackup.slice(0, 10), todayIso)) : null;
  const showBackup = backupDays === null || backupDays >= 14;

  const bar = (pctH: number) => `height:${Math.max(0, Math.min(100, pctH))}%`;

  body.innerHTML = `
    <div class="dash-today">
      <div class="dash-today-title">오늘의 할 일</div>
      <div class="dash-today-nums">
        <div><div class="dt-num">${targets}</div><div class="dt-lbl">만료 예정</div></div>
        <div><div class="dt-num dt-warn">${unsent}</div><div class="dt-lbl">미발송 대기</div></div>
        <div><div class="dt-num dt-danger">${unvisitedCount}</div><div class="dt-lbl">미방문</div></div>
      </div>
      <div class="dash-today-foot">
        <span>마지막 스캔 <b>${esc(S.LAST_SCAN || "없음")}</b></span>
        <button class="dt-scan" id="dash-scan"${S.SCANNING ? " disabled" : ""}>${S.SCANNING ? "스캔 중…" : "지금 스캔"}</button>
      </div>
    </div>
    ${showBackup ? `
    <div class="banner banner-warn">
      <div class="banner-icon">${LK_WARN_ICON}</div>
      <div class="banner-txt">
        <div class="banner-title">${backupDays === null ? "데이터 백업을 한 적이 없습니다" : `데이터 백업이 ${backupDays}일 전입니다`}</div>
        <div class="banner-sub">이력·중복방지 기록은 폰에만 저장돼요. 설정에서 백업하세요.</div>
      </div>
      <button class="banner-btn" id="dash-backup-go">백업</button>
    </div>` : ""}
    <div class="dash-card">
      <div class="dash-h">임박 고객</div>
      <div class="dash-sub">D-3 이내 만료 · 아직 안내하지 않은 대상 (지난 안내 포함)</div>
      ${soon.length ? soon.map((x) => `
        <div class="dash-soon">
          <div class="ds-info"><div class="ds-name">${esc(x.r.customer) || "-"}</div><div class="ds-phone">${esc(x.r.phone)}</div></div>
          <span class="lc-dday ${x.dd <= 0 ? "urgent" : ""}">${x.dd === 0 ? "D-day" : x.dd < 0 ? "D+" + -x.dd : "D-" + x.dd}</span>
        </div>`).join("") : `<div class="dash-empty">임박 대상이 없습니다</div>`}
    </div>
    <div class="dash-card">
      <div class="dash-h">발송 추세</div>
      <div class="dash-sub">최근 7일 일별 발송 건수</div>
      <div class="dash-bars">
        ${trend.map((d) => `
          <div class="db-col">
            <div class="db-val">${d.count}</div>
            <div class="db-bartrack"><div class="db-bar" style="${bar((d.count / trendMax) * 100)}"></div></div>
            <div class="db-day">${esc(d.dayLabel)}</div>
          </div>`).join("")}
      </div>
    </div>
    <div class="dash-card">
      <div class="dash-h">통신사별 분포</div>
      <div class="dash-sub">이번 만료 대상 기준</div>
      ${carriers.length && targets ? carriers.map((c) => `
        <div class="dash-crow">
          <div class="dc-top"><span>${esc(c.name)}</span><span class="dc-cnt">${c.count}명</span></div>
          <div class="dc-track"><div class="dc-fill" style="width:${Math.round((c.count / carrierMax) * 100)}%"></div></div>
        </div>`).join("") : `<div class="dash-empty">${esc(carrierEmptyText(S.SCAN_DATE, todayIso, S.LAST_SCAN))}</div>`}
    </div>
    <div class="dash-card">
      <div class="dash-h">재방문 전환율</div>
      ${cohort.total === 0 ? `
        <div class="dash-sub">최근 ${COHORT_WINDOW_DAYS}일 만료 고객 재방문 현황</div>
        <div class="dash-empty">아직 집계할 만료 고객이 없습니다.<br/>스캔을 계속하면 데이터가 쌓입니다.</div>
      ` : `
        <div class="dash-sub">최근 ${COHORT_WINDOW_DAYS}일 만료 ${cohort.total}명 중 재방문 현황</div>
        <div class="dash-rate"><span class="dr-big">${cohort.revisitRate}%</span><span class="dr-cap">${cohort.revisited}명 재방문</span></div>
        <div class="dash-div"></div>
        <div class="dash-sub2">안내 발송 여부별 재방문율</div>
        <div class="dash-crow">
          <div class="dc-top"><span>안내 발송함 (${cohort.informed}명)</span><span class="dc-pct-ok">${cohort.informedRate}%</span></div>
          <div class="dc-track"><div class="dc-fill dc-green" style="width:${cohort.informedRate}%"></div></div>
        </div>
        <div class="dash-crow">
          <div class="dc-top"><span>안내 미발송 (${cohort.uninformed}명)</span><span class="dc-pct-mut">${cohort.uninformedRate}%</span></div>
          <div class="dc-track"><div class="dc-fill dc-grey" style="width:${cohort.uninformedRate}%"></div></div>
        </div>
      `}
    </div>`;

  $("#dash-scan").onclick = () => void dashScan();
  const backupGo = document.querySelector("#dash-backup-go") as HTMLElement | null;
  if (backupGo) backupGo.onclick = () => hooks.showScreen("settings");
}

/** 대시보드 '지금 스캔'. doScan disables/re-labels every scan button and redraws
 *  the dashboard when it ends, whichever screen started it (#49). */
async function dashScan(): Promise<void> {
  if (S.SCANNING) { toast("이미 스캔 중입니다"); return; }
  await doScan();
}
