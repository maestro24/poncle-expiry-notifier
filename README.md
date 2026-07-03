# 약정만료 알리미 (Poncle Contract-Expiry Notifier)

폰클(Poncle) 개통 데이터에서 **2년 약정이 만료되는 고객을 자동으로 찾아 사내에 알림**을 주는 Windows 데스크톱 프로그램.

- 예: `2024-06-15` 개통 → `2026-06-15` 약정 만료 → 그날(또는 D-7/D-30) 자동 감지 → "OOO 고객님 약정 만료" 알림
- 알림 대상은 **우리 회사(직원)** 입니다. 고객에게 직접 문자를 보내는 게 아니라, 직원이 확인하고 대응하도록 내부에 알립니다.
- 컴퓨터를 켜면 자동 실행되고 평소엔 **시스템 트레이**에 조용히 상주합니다.

---

## 어떻게 동작하나 (핵심 설계)

1. **로그인 (Approach A · 세션 재사용)**
   폰클 로그인 페이지에 `reCAPTCHA`가 걸려 있어 아이디/비번 자동 로그인은 막힙니다. 그래서 이 앱은
   **직원이 앱 안에서 폰클에 한 번 직접 로그인**하면, 그 세션 쿠키만 넘겨받아 재사용합니다.
   비밀번호는 앱이 절대 보지도, 저장하지도 않습니다. 세션이 만료되면 앱이 "세션만료" 상태로 바뀌며 재로그인을 요청합니다.

2. **데이터 수집 (스크래핑)**
   폰클 내부 JSON API `GET /open/listOpen` 를 재사용 세션 쿠키로 직접 호출합니다. 브라우저 창을 띄우지
   않는 순수 HTTP 요청이라 가볍고 빠릅니다. 오늘 알림이 필요한 **개통일만 좁혀서** 조회합니다
   (`오늘 - 약정기간`). 서버 날짜필터가 안 먹으면 자동으로 전체 스캔으로 폴백합니다.

3. **만료 판정**
   `개통일 + 약정기간(기본 24개월)` = 만료일. 상품별 예외 규칙(예: 유심MNP = 무약정)으로 조정 가능.
   모든 계산은 앱에서(client-side) 다시 검증하므로 서버 필터 동작과 무관하게 **정확**합니다.

4. **중복 방지 (crash-safe)**
   `(전화번호, 만료일, 알림시점)` 을 로컬 SQLite `sent_log` 테이블에 `UNIQUE` 로 저장합니다.
   **알림 성공 즉시 한 건씩 커밋**하므로, 실행 중간에 꺼지거나 재부팅해도:
   - 이미 보낸 사람은 다시 안 보냄
   - 아직 못 보낸 사람은 다음 실행에서 이어서 보냄
   "오늘 실행했나" 같은 플래그가 없어서 헷갈릴 여지가 없습니다. 실패한 건은 기록하지 않아 다음 실행에 재시도됩니다.

5. **알림 채널 (플러그형)**
   - 앱 내부 로그·이력 (항상, 기본 알림 창구)
   - Windows 데스크톱 토스트
   - (선택) Slack / Discord / KakaoWork / 일반 웹훅
   설정에서 켜고 끄며, 새 채널은 `backend/notifier.py` 에 메서드 하나 추가하면 됩니다.

6. **실행 방식**
   Windows **시작프로그램**에 등록되어 로그인 시 자동 실행. 실행 직후 1회 + 매일 지정 시각에 스캔.

---

## 직원용: 원클릭 설치 (Python 불필요)

배포 파일은 **`약정만료 알리미.exe` 단 하나**입니다. 파이썬도, 다른 어떤 것도 설치할 필요 없습니다.

1. `약정만료 알리미.exe` 를 직원 PC로 복사합니다. (USB / 사내 공유 / 메일 등)
2. **더블클릭 한 번.** 프로그램이 스스로:
   - `%LOCALAPPDATA%\Programs\약정만료 알리미\` 에 설치되고 (관리자 권한 불필요)
   - **바탕화면에 바로가기 아이콘**을 만들고
   - 설치된 위치에서 다시 실행되어 **창(GUI)이 뜹니다.**
3. 이후로는 **바탕화면 아이콘을 클릭**하면 바로 실행됩니다.

> Windows 11 은 WebView2 가 기본 내장되어 그대로 실행됩니다. 아주 드물게 창이 안 뜨면
> (구형 이미지 등) 안내 메시지가 뜨며, "Microsoft Edge WebView2 Runtime" 을 한 번 설치하면 됩니다.

### 첫 사용 순서
1. 실행 → 상태가 **"세션만료"** 로 보이고 상단에 노란 배너가 뜹니다.
2. **[폰클 로그인]** 클릭 → 폰클 창이 열립니다. 평소처럼 로그인하세요.
3. 로그인이 확인되면 창이 닫히고 상태가 **"대기중"** 으로 바뀝니다. (세션 저장 완료)
4. **[지금 다시 스캔]** 을 눌러 즉시 확인하거나, 매일 정해진 시각에 자동 실행됩니다.

### 컴퓨터 켜면 자동 실행
- 설정 → **"Windows 시작프로그램 등록"** 체크 → 저장. (설치된 exe 가 로그온 시 자동 실행됩니다.)

---

## 개발자용: 소스로 실행 / exe 빌드

> 사전 준비: **Python 3.10+** (3.12 권장), Windows 10/11.

```powershell
cd C:\Users\User\Documents\coding\poncle-expiry-notifier
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# 소스로 실행 (디버깅: 콘솔 로그 보임)
.\.venv\Scripts\python.exe app.py
```

### 배포용 exe 빌드
```powershell
pip install pyinstaller
python build.py
# 결과물: dist\약정만료 알리미.exe  (이 파일 하나만 직원에게 배포)
```

`build.py` 는 PyInstaller `--onefile --windowed` 로 파이썬·pywebview·트레이·토스트까지 전부
하나의 exe 에 담습니다. 빌드 검증: `dist\약정만료 알리미.exe --selftest` (성공 시 종료코드 0,
`%TEMP%\poncle_selftest.txt` 에 `SELFTEST_OK` 기록).

---

## 설정 항목 (앱 → 설정)

| 항목 | 설명 |
|------|------|
| 기본 약정 기간 | 기본 24개월 |
| 알림 시점 | 당일(D-day) / 7일 전 / 30일 전 중 선택(복수 가능). 시점별로 각각 1회 알림 |
| 매일 실행 시각 | 예 09:00. 시작 직후 1회 실행 옵션 |
| 시작프로그램 등록 | 컴퓨터 켤 때 자동 실행 |
| 알림 문구 템플릿 | `{customer} {phone} {expiry} {opendate} {telecom} {agency} {plan} {model} {staff} {when}` |
| 알림 채널 | 토스트 / 앱내부 / 웹훅 |
| 약정 예외 규칙 | 상품별 약정을 다르게. 예: `[{"field":"openhowx","match":"유심","term_months":0}]` → 유심 건은 무약정으로 제외 |

---

## 데이터 저장 위치

모든 상태는 `%LOCALAPPDATA%\PoncleExpiryNotifier\` 아래에 저장됩니다.

| 파일 | 내용 |
|------|------|
| `settings.json` | 설정 |
| `notifier.db` | SQLite: 발송이력(dedup) + 이벤트 로그 |
| `session_cookies.json` | 재사용 폰클 세션 쿠키 (로컬 전용) |
| `app.log` | (예약) 로그 |

> 세션 쿠키는 폰클 접속 토큰입니다. 이 PC를 여러 명이 공유한다면 계정 보안에 유의하세요.

---

## 테스트

```powershell
python -m unittest discover -s tests -p "test_*.py" -v
```

만료 계산(윤년/월말 클램프/D-7/무약정 제외)과 마스킹·중복방지 로직을 검증합니다.

---

## 폴더 구조

```
poncle-expiry-notifier/
├─ app.py                    # 진입점: WebView 창 + 트레이 + 스케줄러 + 로그인 플로우
├─ backend/
│  ├─ config.py              # 설정 로드/저장 (settings.json)
│  ├─ paths.py               # 사용자 데이터 경로
│  ├─ session.py             # 폰클 세션 쿠키 재사용 + 유효성 검사
│  ├─ poncle_client.py       # /open/listOpen 조회 + 페이징 + 폴백
│  ├─ expiry.py              # 만료일 계산 (순수 로직, 테스트됨)
│  ├─ db.py                  # SQLite: dedup(sent_log) + events + meta
│  ├─ notifier.py            # 알림 채널 (토스트/웹훅, 플러그형)
│  ├─ scan.py                # 오케스트레이터 (조회→판정→중복검사→발송→기록)
│  ├─ scheduler.py           # 매일 실행 스케줄
│  ├─ autostart.py           # Windows 시작프로그램 등록
│  ├─ masking.py             # 화면 표시용 PII 마스킹
│  ├─ ui_serialize.py        # UI 전송용 직렬화(마스킹 적용)
│  └─ api.py                 # 프론트↔백엔드 JS 브릿지
├─ frontend/                 # WebView UI (index.html / styles.css / app.js)
├─ tests/                    # 단위 테스트
├─ assets/                   # 아이콘 (자동 생성)
└─ requirements.txt
```

---

## 알아둘 점 / 한계

- **로그인 세션 수명**: 폰클이 세션을 만료시키면 재로그인이 필요합니다. 앱이 자동 감지해 "세션만료" 로
  표시하고 재로그인을 요청합니다. 보통 며칠 단위로 유지됩니다.
- **쿠키 추출**: pywebview 의 `get_cookies()` 로 로그인 세션을 넘겨받습니다. WebView2 백엔드에서 동작하도록
  구현했지만, 환경에 따라 동작이 다르면 `backend/session.py` / `app.py` 의 `_extract_cookies` 를 조정하세요.
- **알림 채널**: 기본은 "앱 내부 로그 + 데스크톱 토스트" 입니다. 팀 채팅으로 받고 싶으면 설정에서 웹훅 URL을
  넣으세요(Slack/Discord/KakaoWork 지원).
- **약정 기간**: 상품마다 다르면 "약정 예외 규칙" 으로 매핑하세요. 규칙이 없으면 전부 24개월로 계산합니다.
