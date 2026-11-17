# 스캔 설계 — 2단계 알림 (요금제 유지 + 약정 만료), 3패스

> 실제 구현: `src/domain/scan.ts` `runScan`. 이 문서는 v1.2.9의 2단계 개편과 2026-11 점검
> (`docs/audit-2026-11-16.md`) 수정 이후의 동작을 설명한다. 예전 "2패스 / 유지일 우선" 설명은
> 더 이상 맞지 않는다.

## 배경

- 고객마다 안내 시점이 두 번 있다.
  - **1단계 — 요금제 유지 (`source = "keepdate"`)**: 개통 후 요금제 유지 기간이 끝나는 시점.
    모든 개통(유심 포함)이 대상.
  - **2단계 — 약정 만료 (`source = "term"`)**: 약정 대상(신규/번호이동/기변)만, 개통 + 약정 개월.
- 요금제 유지일(날짜)은 **개통업무 목록(`/open/listOpen`)에는 없다.** 개통일만 있다.
  유지일은 **미결관리(`/pending/listPending`, `gubun=2` 요금제유지)의 `pendingdate`** 에만 있다.
  미결에는 개통 유형/통신사가 없으므로 전화번호(`openphone`, 숫자만 정규화)로 개통 행과 조인한다.
- 유지일이 등록되지 않은 고객은 **개통 + 요금제 유지 기본 개월**(설정 > 약정 기간, 기본 6)로 1단계를 계산한다.

## 순서

1. **미결 먼저** (`client.fetchPending()`): 이후 패스 B의 블랙리스트에 필요하다.
   - `SessionExpired` → 스캔 결과 `session_expired` (목록·'마지막 스캔' 그대로).
   - 그 밖의 실패 → **저하(degraded)**: 미결을 빈 목록으로 두고 계속한다(아래 "저하 스캔").
2. **개통 목록** (`client.fetchCandidates(scanOpenDateBounds(...))`): 1·2단계와 미방문 계산의 공통 소스.
   조회 범위는 약정/유지 개월, 안내 시점, 미방문 추적 기간, catch-up을 모두 덮도록 넓힌다.
   실패하면 `session_expired` / `error` (기존과 동일).
   - 페이징은 `list.length === page_size` 인 동안 계속 받는다(서버 `total`이 0이거나 파싱되지 않아도).
     `maxPages` 상한은 유지한다.
3. 전화번호별 **최신 개통**(`latestOpenByPhone`) = 그 고객의 현재 계약. 모든 패스가 이것을 기준으로 한다.

## 3패스

### 패스 A — 1단계, 폰클 유지일
- `keepDueRows`: `isKeepPending`(요금제유지) 이고 **미해결**(`condx !== "해결"`)인 미결 중,
  `pendingdate`가 안내 범위(오늘 ~ 오늘+안내 시점, catch-up 포함)인 것.
  - 번호가 빈 행은 버린다(모두 `|날짜` 한 키로 뭉치므로).
  - 한 번호에 미해결 유지일이 여러 개면 **가장 늦은 유지일 하나**만 남긴다(audit 1-36).
- 유지일이 현재 개통보다 이전이면(`isStaleKeepdate`) 이전 계약의 것이므로 건너뛴다(audit 1-16).
- 최신 개통 맵에 없으면 `fetchOpenByPhone`으로 단건 조인한다. **번호가 정확히 일치하는 행만** 쓰고,
  없으면 조인 없이(유형 공란) 낸다(audit 1-17).
- `expiry_date = 유지일`.

### 패스 B — 1단계, 개통 + 기본 개월
- 최신 개통마다 `개통일 + keepdate_default_months`가 안내 범위면 낸다.
- **블랙리스트**(`keepPhoneSet(pendingRows, latestOpen)`)에 있는 번호는 건너뛴다 — 패스 A가 담당.
  블랙리스트는 **현재 계약의 유지일**만 센다(이전 계약의 해결된 유지일이 현재 계약의 1단계를 영구히
  막던 문제, audit 1-16). 현재 계약의 유지일이 `해결`이면 폰클에서 이미 처리한 것이므로 역시
  블랙리스트에 남아 기본 개월로 다시 안내하지 않는다.
- 저하 스캔이면 항목에 `degraded: true`를 붙인다(유지일이 있는 고객일 수 있어 날짜를 믿을 수 없다).

### 패스 C — 2단계, 약정 만료
- 최신 개통 중 약정 대상(`isContractType`: 신규/번호이동/기변)만, `개통일 + default_term_months`.
- 유지일 유무와 무관하다.

### 병합 — **약정 만료(term) 우선**
- 키 = `dueKey(phone, expiry_date)` (숫자만 정규화한 번호 | 만료일). 1단계와 2단계는 보통 날짜가
  달라 둘 다 살아남는다.
- 같은 날짜로 충돌하는 드문 경우(기본 개월 == 약정 개월, 유지일이 개통+약정과 같은 날)에는
  `[...termItems, ...keepItems, ...stage1Default]` 순서로 먼저 들어온 **term이 이긴다**.
  계약 고객에게는 약정 만료 안내가 더 실행 가능한 알림이기 때문이다.

### 발송 상태와 정렬
- `history.sentIndex(cfg)`로 `sent_state` / `already_sent`를 붙인다. 정확한 `phone|expiry` 기록이
  없어도 **같은 계약·같은 단계**의 발송(약정 개월 변경, 유지일 vs 기본 개월 등으로 만료일이 달라진
  경우)을 찾아 맞춘다(audit 1-29/1-30). 실제 SMS(실패 아님)와 수동 제외만 '처리됨'으로 센다 —
  연습(record-only) 기록과 발송 실패는 다시 보낼 수 있다(audit 1-2).
- 정렬(`sortDueItems`): **미발송 먼저**, 그 안에서 **만료일 오름차순**(지난 D+N이 맨 위), 같으면
  개통일, 번호 순. 홈은 발송·복원 뒤 상태를 다시 맞출 때마다 같은 정렬을 다시 적용한다(#52).

## 지난 마일스톤 따라잡기 (catch-up, audit 1-4)
- 앱은 `last_clean_scan_date`(저하되지 않은 마지막 정상 스캔일)를 기억한다. 다음 스캔은 그날 이후
  지나간 마일스톤(최대 `CATCH_UP_MAX_DAYS` = 14일)을 **D+N(지남)** 으로 다시 포함한다. 휴무일·주말에
  앱을 열지 않아도 1단계 안내가 조용히 사라지지 않는다.
- 업그레이드 직후(기준일 없음)는 캐시의 스캔일로 대신한다.

## 저하 스캔 (미결 조회 실패, audit 1-30)
- 미결 조회가 세션 만료가 아닌 이유로 실패하면 미결을 빈 목록으로 두고 스캔을 계속한다.
- 블랙리스트가 비어 패스 B가 유지일 고객에게도 개통+기본 개월 항목을 만들 수 있으므로:
  - 해당 항목에 `degraded: true` → 홈에 경고 배너, **그 항목의 발송을 막는다**.
  - 미방문 캐시를 덮어쓰지 않고, 코호트를 갱신하지 않으며, catch-up 기준일을 옮기지 않는다.
- 다음 정상 스캔에서 복구된다.

## 미방문과 코호트
- `computeUnvisited(openRows, cfg, today, sentIdx, pendingRows)`: 대표 만료(약정 대상 = 약정 만료,
  그 외 = 폰클 유지일 또는 개통 + 기본 개월)가 지났는데 새 개통이 없는 고객. 유지일을 쓰므로 홈과
  키가 같다(audit 1-10).
- 코호트(재방문 전환율)는 정상 스캔에서만 갱신한다. 안내 후 만료 전에 재계약한 고객도 넣는다(1-19).
- 미방문 수동 제외 목록과 코호트는 백업에 함께 들어가고, 복원 시 이 폰의 것과 합친다(#55).

## 데이터 매핑

### 미결 행 (`/pending/listPending`, gubun=2)
| 필드 | 용도 |
|---|---|
| `pendingdate` (yyyy-mm-dd) | 유지일 (패스 A 기준일) |
| `openphone` / `phone` | 조인 키 + 블랙리스트 키 (숫자만 정규화) |
| `gubunx` (="요금제유지") | 필터 확인 (서버 gubun=2 + 클라이언트 재확인) |
| `condx` (접수/해결) | "해결"은 패스 A에서 제외(블랙리스트에는 남음) |
| `name` | 조인 실패 시 고객명 대체 |

### 개통 행 — `entryFromRow`
`openhowx`(유형), `telecomx`(통신사), `customer`, `opendate`, `agencytitle`, `plan`, `model`, `membername`.
HTML 엔티티(`&amp;` 등)는 항목을 만들 때 디코딩한다(audit 1-34).

**요금제명이 잘리는 문제 (#61 조사, 미해결):** 실기기에서 `LTE스페셜32990(약정형`, `폰케어 초이스 스`처럼
잘린 요금제명이 보였다. 앱의 `cleanPlan`은 공백만 정리하고 자르지 않으며, 앱이 쓰는 요금제 필드는
`listOpen` 행의 `plan` 하나뿐이다(`entryFromRow`, `buildLookupResults`). 코드·테스트 픽스처·PC 백엔드
어디에도 더 긴 요금제 필드가 없어, 잘림은 `listOpen` 응답 자체의 것으로 본다. 전체 이름을 주는 필드가
있는지는 폰클 웹의 `listOpen` 응답(또는 개통정보 상세의 가입정보)을 직접 확인해야 하며, 확인되기 전에는
그대로 둔다. 그때까지 `{plan}`/`{요금제}`를 넣은 문구는 발송 확인창에서 요금제명을 눈으로 확인하고 보낸다.

## 관련 파일
- `src/domain/scan.ts` — 오케스트레이션(위 순서와 3패스, 병합, 정렬, 미방문·코호트)
- `src/domain/keepdate.ts` — `keepDueRows`, `keepPhoneSet`, `isStaleKeepdate`, `keepDueItem`, `dueKey`
- `src/domain/expiry.ts` — `milestoneDue`, `scanOpenDateBounds`, catch-up
- `src/domain/due-item.ts` — `entryFromRow`, `sortDueItems`, `refreshDueOffsets`
- `src/domain/poncle-client.ts` — `fetchPending`, `fetchCandidates`(페이징), `fetchOpenByPhone`
- `src/domain/unvisited.ts`, `src/domain/cohort.ts`

## 설정
별도 토글 없음. 미결이 0건이면 패스 A가 비고, 모든 고객이 패스 B(기본 개월)와 패스 C(약정 만료)로 계산된다.
