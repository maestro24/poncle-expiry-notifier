# 요금제 유지일 기반 스캔 (하이브리드) — 설계

## 배경 / 결정

기존 스캔은 **개통일 + 약정개월**로 만료일을 계산해 안내 대상을 뽑는다. 실제 안내 기준은
폰클의 **요금제 유지일**(개통일 + N일, 예: 183일)이 더 정확하다는 요구가 나왔다.

- 요금제 유지일(날짜)은 **개통업무 목록(`/open/listOpen`)에는 없다.** 개통일만 있다.
- 유지일은 **미결관리(`/pending/listPending`)의 `pendingdate`** 에만 값으로 담긴다. (개통 시
  "요금제유지" 체크박스를 켜면 미결로 자동 등록됨. `gubunx = "요금제유지"`.)
- 미결에는 **개통 유형/통신사가 없다.** 그건 개통업무에 있다.
- 두 소스는 `openphone`(전화번호)로 **JOIN** 된다 (실측 100% 매칭).

커버리지 현실: 현재 요금제유지 미결은 소수(수십 건)뿐이고, 앞으로 매 개통마다 체크박스를
켜는 운영을 전제로 한다. 이미 개통된(미체크) 고객은 유지일이 없다.

→ **하이브리드**: 유지일이 있으면 유지일로, 없으면 기존 약정계산으로. (기존 동작을 절대
깨지 않는 순수 가산 변경 — 미결이 0건이면 현재와 동일하게 동작.)

## 스캔 = 2패스 병합

각 고객은 **유지일 있냐/없냐**로 갈려 정확히 한 패스에만 속한다 (겹치지 않게 설계).

### 패스 1 — 유지일 기준
1. `listPending`에서 `gubun=2`(요금제유지) 미결을 전부 가져온다 (작음, 페이지네이션).
2. `condx === "해결"` 인 것은 제외 (이미 처리/재계약 완료 → 안내 불필요).
3. `pendingdate`(= 유지일)가 안내시점 범위 `[오늘, 오늘+N]` 안인 것만 남긴다.
4. 각 건을 전화번호로 개통업무에 조인해 유형/통신사/모델/거래처를 붙인다.
   - 조인 소스: (a) 패스2에서 이미 받은 개통목록 맵을 먼저 조회, (b) 없으면 `listOpen?q=전화번호`
     단건 조회. (c) 그래도 없으면 유형 공란(템플릿 "모든 통신사/모든 상태"만 매칭).
5. `expiry_date = 유지일`, `source = "keepdate"` 로 DueItem 생성.

### 패스 2 — 약정 계산 기준 (기존)
1. `candidateOpenDateBounds`로 개통목록을 받아 `dueWithin`(개통일+약정개월)로 판단 — **현행 그대로**.
2. **단, 블랙리스트 제외**: 요금제유지 미결이 있는 **모든 전화번호**(범위 무관, 접수/해결 무관)는
   패스2에서 통째로 스킵. 그 고객은 유지일로만 산다.
3. `source = "term"`.

### 병합
- 전화번호로 dedup, **유지일(패스1) 우선**. (블랙리스트 덕분에 원래 겹치지 않지만 안전장치.)
- 이후 기존과 동일: `already_sent` 표시(이력 dedup), 정렬(미발송 먼저 → opendate 오름차순).

### 왜 "블랙리스트는 범위 무관 전부"인가
유지일 3/1(멂) + 약정만료 오늘인 고객: 블랙리스트가 "범위 안 유지일만"이면 패스2로 새서
오늘 잘못 뜬다. 유지일 있는 번호는 **날짜 불문 패스2에서 영구 제외** → 3/1에 패스1로만 뜬다.

## 실패/세션 처리
- 미결·개통 둘 다 인증 GET. 미결 조회를 **먼저** 수행:
  - `SessionExpired`(진짜 로그아웃) → 스캔 `session_expired`.
  - 그 외 미결 실패(네트워크/네이티브 문제) → **term-only로 degrade**(빈 미결). 유지일 이전
    동작과 동일하므로 미결 일시 장애가 스캔 자체를 막지 않음. (degrade 시 유지일 등록 고객이
    그날 약정 근사치로 뜰 수 있으나, 이는 기존 동작이며 다음 스캔에서 복구됨.)
- 개통 조회 실패는 기존과 동일(`session_expired` / `error`).

## 데이터 매핑

### 미결 행 (`/pending/listPending`, gubun=2)
| 필드 | 용도 |
|---|---|
| `pendingdate` (yyyy-mm-dd) | 유지일 (패스1 기준일) |
| `openphone` / `phone` | 조인키 + 블랙리스트 키 (숫자만 정규화) |
| `gubunx` (="요금제유지") | 필터 확인 (서버 gubun=2 + 클라 재확인) |
| `condx` (접수/해결) | "해결" 패스1 제외 |
| `name` | 조인 실패 시 고객명 폴백 |

### 개통 행 (조인) — 기존 `entryFromRow`와 동일 필드 사용
`openhowx`(유형), `telecomx`(통신사), `customer`, `opendate`, `agencytitle`, `plan`, `model`, `membername`.

## 파일 변경
- `android/.../PonclePlugin.java`: `getListOpen` → 범용 `getJson(path, referer)` 로 일반화 +
  `listPending` @PluginMethod 추가. `listOpen` 동작 불변.
- `src/native/poncle.ts`: `PonclePlugin`에 `listPending` 추가 + web 폴백.
- `src/native/adapters.ts`: `nativePoncleGateway`에 `listPending` 추가.
- `src/domain/poncle-client.ts`: `PoncleGateway`에 `listPending`; `PoncleClient`에 `fetchPending`
  (페이저) + `fetchOpenByPhone` (단건 조인 조회).
- `src/domain/keepdate.ts` (신규, 순수): `normalizePhone`, `isKeepPending`, `keepPhoneSet`(블랙
  리스트), `keepDueRows`(범위+해결 필터), `keepDueItem`(조인 후 DueItem 조립).
- `src/domain/scan.ts`: 2패스 병합 오케스트레이션.
- `src/domain/types.ts`: `DueItem.source?: "keepdate" | "term"`.
- `src/main.ts`: `whyText`가 `source==="keepdate"`면 "요금제 유지일 기준" 표기.
- 테스트: `keepdate.test.ts`(신규) + `scan-sender.test.ts` 페이크 게이트웨이에 `listPending` 추가
  및 하이브리드 케이스.

## 설정
별도 토글 없음. 미결 0건이면 패스1 공집합 → 기존과 동일. 순수 가산.
