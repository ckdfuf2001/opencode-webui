# Handoff — 2026-10-19 기준

## 메모리 트랙 상태 (M2~M8, 2026-10-19)

### M12/M14 진행 위치 (2026-10-20, HEAD 5d9b27b → 후속 커밋)

#### M14 실험 결과(데이터 유실) — 공동편집 저장 유실

직접 재현(커밋 후 300ms 간격 20회 관측 + 커밋 방식 3종 비교):

| 커밋 방식 | 커밋 직후 DOM | 3초 | 10초 | 디스크 | write-back 타임라인 |
|---|---|---|---|---|---|
| **Escape** | 편집 상태 | `Hello` | `Hello` | **NO** | enter→save ok(**커밋 전 내용**)→viewerKey.change(리마운트)→save.skip(empty)→**이후 호출 없음** |
| **바깥 클릭** | 편집 유지 | — | — | **YES** | enter(+2.5s=P1-5 debounce)→save ok |
| **다른 도형 클릭** | `Hello from Ada` | — | — | **YES** | enter→ok, 그리고 2번째 enter→ok |

**확정 결론**
1. lib 의 커밋 후 리렌더는 **정상**(커밋 +0.4초에 DOM 반영) → "구 내용 직렬화" 해석은 **철회**.
2. 실제 원인: **커밋 직후 lib 의 write-back 이 호출되지 않음** + **편집 모드 종료로 인한 리마운트가
   그 미처리 write-back 을 유실** → 편집이 디스크에 반영되지 않음(조용한 유실).
   ⇒ "lib 내부"가 아니라 **앱이 리마운트를 너무 일찍 한다**는 문제(→ 앱에서 수정, v0.13 이월 안 함).
3. 피해는 **"Escape 로 편집을 끝낼 때"**로 좁혀짐(바깥 클릭·다른 도형 클릭은 정상 반영).
4. **P0(1절 a) 결과**: A(먼저 접속·보기)는 owner 가 **아니었고**(역할 viewer), B(편집)가 owner 였다.
   서버 owner 규칙에 "편집 모드" 조건은 없으나, **owner 가 보기 모드일 때 아무도 저장하지 않는
   구조는 이 시나리오에서 재현되지 않았다**. (B=owner 의 커밋이 같은 결함으로 유실됨은 동일.)
5. 1절 판정표 2행("14.7초에 있음 + 종료 시점에 없음")은 **기각**(14.7초 파일에 이미 편집 없음).

#### M15 진행 (2026-10-20)

**1절 2인 E2b 진단(E2b spec 그대로 + `[collab-tl]` 콘솔 수집) — A 타임라인 원문 요약**

```
12723 viewerKey.change view → edit          (편집 진입)
13577 meta owner=A
17795 writeback.enter {isOwner:true, bytes:8145}
17912 save.response {ok:true, bytes:8145}   ← 커밋 write-back 저장 성공
18449 flush.commit_applied {bytes:8140}     ← 모델 기준 대기 성공(타임아웃 아님)
18591 save.response {ok:true, bytes:8140}   ← flush 저장이 커밋 write-back 과 다른 바이트
18632 viewerKey.change edit → view (리마운트)
18681 save.skip empty_bytes
18991 meta owner=null
```

**판정**: M15 0절 결함 1·2가 확인됨 — 이전 구현은 `flush.commit_wait_timeout`이 매번 발생해
**1초 고정 sleep 효과**로 동작했고(=1인 "성공"은 가짜였음), DOM 안정 ≠ 모델 반영.
모델 기준 교체 후 `flush.commit_applied`로 타임아웃 없이 판정되나, **저장 바이트가 커밋 write-back 과
다르다(8140 vs 8145)** — "모델이 달라졌다"는 변화가 커밋인지 직렬화 시점 메타데이터 차이인지
구분되지 않는다. ⇒ **텍스트 기준 판정(또는 lib 커밋 API) 필요 — 다음 세션 시작점.**

**3절 대응표 (커밋 분리)**

| 지시 | 커밋 | 상태 |
|---|---|---|
| ① 계측 | ee12673 (M11) + M15 ②의 `flush.commit_*` 로그 | 완료 |
| ② 대기 판정 교체 | `ff7536b` (모델 기준) | 완료(텍스트 기준은 미완) |
| ③ 이벤트 범위 한정 | `835f2c1` (FilePreview가 path 전달 + DocumentPreview가 경로 비교) | 완료 |
| ④ spec | `9dc299d` (E2c 신설 + E2b 타임라인 수집) | 완료 |
| ⑤ docs | 이 커밋 | 완료 |
| a55fbfc 커밋 분리 위반 | 되돌리지 않음(force push 금지). docs/spec/prod 혼재 사실만 기록 | 대응 완료 |

**미해결(다음 세션 시작점)**
1. flush 저장 바이트가 커밋 write-back 과 다름 → **커밋 반영 판정을 텍스트 기준으로**(2절) 또는
   lib dist grep으로 커밋/flush/blur API 존재 확인(2절 우선순위 1).
2. 2인 E2b 여전히 실패(디스크 반영 안 됨).
3. E2d(PPT/XLSX 동시 편집 — B1(b) 재발 검사) 미작성.
4. lib 이 제공하는 커밋 신호가 있으면 그걸로 대기를 대체(C안).


- `DocumentPreview`: `fileFullscreenChange`(Escape) → 기존 `endEditing()`(=flush await → 종료)로 통일.
  PptxViewer 리스너 방식은 금지(경합).
- `PptxViewer`: flush 전에 **커밋 반영 대기**(편집 입력칸 소멸 + DOM 텍스트 2회 연속 안정, 최대 1초) → getContent → 저장.
- 단일 페이지 실험 결과: **Escape 후 +300ms에 disk=YES**(수정 전 NO) ✓
- **미해결**: 2인 구성(E2b)에서 여전히 실패. 1인에서는 성공. 다음 세션 시작점.


| 구간 | 상태 |
|---|---|
| M12-1절 디스크 실물 확인 | **완료** — 판정 "14.7초부터 없음"(저장 바이트에 편집 미포함) |
| M12-2절 저장 바이트 출처 | **진행** — 바이트는 lib 뷰어 getContent 결과( Y.Doc 아님). 뷰어 DOM 이 커밋 후 갱신되지 않음 |
| M12-3절 종료 플러시 순서 | **결정만 기록(D38)** — b78a2ff 의 fileFullscreenChange 플러시는 **증거 없음으로 되돌림** |
| M12-4절 E2E 설정·분류 | **완료** — serial 해제, 62개 1회 실행 = 24 passed / 40 failed( chromium 20 + msedge 20 ) |
| 태그 v0.12.70 | **미부착** (디스크 반영 계열 E2/E2b/E4 미통과) |

**M12 1절 판정표**

| 관측 | 결과 | 원인 | 다음 |
|---|---|---|---|
| 저장 직후 파일의 `a:t` | `Hello` (편집 없음) | 저장 바이트에 편집 미포함 | 2절 |

파일 diff(원본 / 저장직후 / 종료시점 모두 동일): `a:t` = `Hello`, `<a:t>` run **1개**, 도형명 `Body 2` 유지.
`helpers/disk.ts` 의 `textOf` 는 **이름(cNvPr/@name) 기준**(`:79`, `:99`)이고 **모든 `<a:t>` run 을 이어 붙여** 비교한다(`:83-93`) → 판독 문제 아님.

**남은 실패(62개 1회 실행, chromium 20건 = msedge 동일 20건)**

| 테스트 | 분류 | 데이터 손실 | 처리 |
|---|---|---|---|
| E2, E2b, E4 | 앱(lib 뷰어 DOM 이 커밋 후 미갱신) | 있음(편집 유실) | 이번 수정 대상 |
| E21b | 앱(D26 커서 DOM 잔존) | 없음 | v0.13 |
| E3, E11m/E3m | 앱(칩/선택 표시) | 없음 | v0.13 |
| E6, E12 | 앱(owner handoff) | 없음 | v0.13 |
| E7, E20, E20s | 앱(리마운트 수) | 없음 | v0.13 |
| E8, E9, E16b, E19b, E15, E18, E21, E11m/E1m, E11m/E2m | 추가 조사 필요 | 확인 필요 | v0.13 |

**되돌릴 후보 커밋**: `06ca84c`(파일 no-store — 무해하지만 **원인 아님**으로 기록하고 유지), `b78a2ff`(fileFullscreenChange 플러시 — **되돌림**).

| 구간 | 상태 | 근거 |
|---|---|---|
| M2 (뷰어 닫기=언마운트) | 완료 | d95f8e7, D32 |
| M3/R1~R3 (세션 registry·lease) | 완료 | 342035c, 28bf811, D30·D31 |
| M4/M5 (원격 커서 제거) | 완료 | 1d9a710, D26 |
| M6 (PPT 동결 기준선) | 완료 | c638efa, D14 |
| M7 유휴 렌더 0회 | 완료 | 43232e2, 199bc09, D35 |
| M7 폴링 단일화 | 완료 | 8683102, D29 |
| M8-0 (문서·기준선) | 완료 | 7b45d1f, f466c97 |
| M8-1 30분 고원 | 완료(결론: JS heap 평탄, 네이티브 +1.9MB/분 계속 상승) | memory-notes §12-1 |
| M8-2 prod 절대 크기 | 완료(prod 덱 1장 +416MB, 10분 고원 도달) | memory-notes §12-2 |
| M9-0 보완(검사 문구·queryCache 테스트) | 완료 | 009db23 |
| M9-6 E2E 하네스 복구 | **완료(8/10 통과)** — E2만 앱 이슈로 잔존 | 1c862bd, 9f86d17 |
| M9-1b 네이티브 귀속 | 진행(N-a 완료, N-b/N-c 진행) | memory-notes §14 |
| M8-4b 채팅 폴링·SSE | 진행 (4b-0 조사 완료) | memory-notes §14 |
| M8-3 절대 크기 분해 | 보류 | prod에서도 덱 1장이 416MB, 목표 150MB |
| M8-5 정리 | 보류 | memCounters observer 정지·NowProvider 1Hz 확인 |

**E2E 하네스 복구로 드러난 앱 이슈(v0.13 이월)**: owner write-back 직후 "external change detected" →
방 재설정 → owner 상실 → 편집이 디스크에 반영되지 않음(E2). PPT 동결 영역이라 이번 커밋에서 제외.
→ memory-notes §14-1 (V1).

**다음 순서**: 1절(완료) → 2절(완료) → 6절(E2E 하네스) → 4b-P0(스트림 1개화) → 4b-1(S-a~C-b 측정) →
4b-2(1 폴링주기 → 2 fastPull 정지 → 5 permission/question 폴링 → 3 코얼레싱 → 4 꼬리창) → 3절 → 5절.

**자동 검사**: `pnpm check:memory` (scripts/check-memory-rules.mjs). 폴링·interval·EventSource 추가 시 실패한다.

## 원격 상태 (2026-10-19 로컬에서 실측)
- `git ls-remote origin main release-0.12` → 양쪽 모두 `d95f8e7be37eeb67bbff4fa62a887ca2308166c9`.
  `fix(viewer): unmount the document viewer on close (M6)`.
- 로컬 `release-0.12`은 `f66f2b6`에서 **118커밋 뒤처져 있었으나** fast-forward로 `d95f8e7`에 정렬했다.
- 작업 트리 클린, `git stash list` 비어 있음. 푸시 안 된 로컬 작업은 없었음.
- 마지막 exe: 0.12.68(보고 기준). 그 이후 브랜치에 태그 없음(브라우저 검증 대기).

## 검증 대기 묶음 (태그 전 필수)
53a0c9d · 3c8e89c · 7e0633b · c5c6b72 · 3e12b25 · b0ab4f7 · 603d511 · cbd69cd · aa47a9f ·
c638efa · e0a901d · 71bb069 · 342035c · 28bf811 · bc80ca1 · 8607716 · b07b49b · d95f8e7

- E2E: `bun run test:e2e:collab --repeat-each=3` (PPT E1–E20s + M6 + X-B1), chromium + msedge
- 사용자 수동 확인:
  ① Chrome 3→1 이동 시 Edge에 슬라이드 1 표시
  ② Edge 이미지 3장
  ③ 혼자 "파일 기준으로 다시 열기"
  ④ PPT 닫은 뒤 viewer-root 0 / `__openSockets()` 0
  ⑤ 10분 방치 `__memFloor` 바닥선 상승 없음

## 기준선 (2026-10-19 실측 — 이전 문서의 "22/22, lint 9"는 오기였음)
| 항목 | 명령 | 실측값 |
|---|---|---|
| 단위+프론트 | `pnpm -C backend test -- run` | **469 passed**, 2 failed suites |
| 타입 | `pnpm -C frontend exec tsc -b` | **에러 0** (exit 0) |
| 린트 | `pnpm -C frontend exec eslint .` | **330 problems (272 errors, 58 warnings)** |
| 메모리 규칙 | `pnpm check:memory` | **오류 0, 경고 1** (D36 EventSource 2곳 — 4b-P0 대상) |

- 실패하는 2개는 `backend/test/services/config-migration.test.ts`,
  `backend/test/services/repo-tracking.test.ts` — 둘 다 `bun:sqlite` 미설치 탓이다.
  기존 AGENTS.md 4절이 이미 "기존 환경실패(`bun:sqlite` 2파일) 외 실패 금지"로 명시한 그대로다.
  **이 2개 외에 실패가 생기면 회귀다.**
- `pnpm -C frontend test` 스크립트는 존재하지 않는다. 프론트 테스트는 백엔드 vitest가
  `backend/vitest.config.ts:23`의 `include: [... '../frontend/test/**/*.{test,spec}.ts']`로 돌린다.
- 이 PC의 `NODE_ENV=production` 때문에 `pnpm install`이 devDependencies를 건너뛴다.
  `$env:NODE_ENV='development'`로 설정하고 설치해야 vitest/tsc가 생긴다.

## M7 측정 보완 (S1 진행 중 메모)

**S1 1분 데이터 정상**(heap 77→68, dom 평탄, aTx 10초 keepalive만). 10분 완료 후 표 보고는 그대로.
**단, S1 결과로 M7 종결 금지** — 아래 보완 후 S0~S5 재측정.

### 0. 원격 확인

```
$ git ls-remote origin main release-0.12
1d9a7109d3c2c7cc8f7413872f01418c7d313304	refs/heads/main
1d9a7109d3c2c7cc8f7413872f01418c7d313304	refs/heads/release-0.12
```

GitHub 커밋 목록 최상단이 `d95f8e7`로 보인 것은 **페이지 캐시**다. 원격에는 `1d9a710`이 있다.
(두 해시 일치 = 푸시 성공)

### 1. 지표 추가 (프로세스 메모리)

probe 로그 한 줄에 다음을 추가한다(CDP + Windows):

- `Performance.getMetrics`: JSHeapUsedSize, JSHeapTotalSize, Nodes, LayoutCount, RecalcStyleCount
- `Memory.getDOMCounters`: documents, nodes, jsEventListeners
- 렌더러/GPU 프로세스 메모리: CDP `SystemInfo.getProcessInfo`로 PID를 얻고
  `Get-Process -Id <pid> | select WorkingSet64, PrivateMemorySize64`

**CDP 함정 두 가지(확인함):**
1. 응답이 배열이 아니라 **`{ processInfo: [...] }`** 다. 배열로 가정하면 조용히 빈 결과가 된다.
2. 타입명은 **`"GPU"`(대문자)**, `"browser"`, `"renderer"`, `"network.mojom.NetworkService"` 다.
   소문자 정규화 없이 `proc.gpu`를 찾으면 undefined가 된다.
3. `SystemInfo.enable`은 존재하지 않는다(호출 시 Protocol error). `getProcessInfo`만 쓰면 된다.

판정 기준: GC 후 JS floor **와** 렌더러 PrivateMemory 둘 다 10분 증가 ≤ 5MB / ≤ 30MB.
사용자는 작업관리자 기준으로 보고 있음 — **렌더러 PrivateMemory가 이에 대응**한다.

### 2. 측정 조건 보완

- **덱**: `e2e/collab/fixtures/make_big.ts`(신규)로 큰 덱을 만든다.
  슬라이드 24장, 이미지 12장(각 1200x900 RGBA), 파일 47.1MB, 디코드 RGBA 49.4MB.
  노이즈 픽셀로 만들어 PNG 압축이 되지 않게 했다(단색이면 deflate가 99% 줄여
  파일 크기만 줄어든다). **커밋하지 않는다**(수십 MB) — 임시 경로에 생성.
  기존 `collab-3slides.pptx`(8x8 단색 PNG 3장, 75B)로는 이미지 경로 판정이 불가능하다.
- **빌드**: prod exe(또는 `vite build` + preview)로 S0~S5 수행. dev(5183) 결과는 참고용 표기.
- **headed chromium + GPU 활성**: 헤드리스는 GPU/이미지 디코드 경로가 다르다.
- **S2~S5**는 두 번째 브라우저 컨텍스트(상대)로 자동 조작:
  S3 마우스 이동 100ms 간격, S4 텍스트 편집 1분 간격, S5 내가 owner로 편집.

### 3. 결과 표 형식

| 조건 | 덱 | 빌드 | JS floor 0→10m | Renderer Private 0→10m | GPU 0→10m | nodes | aTx/aRx per min |
|---|---|---|---|---|---|---|---|

처음으로 기준을 넘는 조건이 범인 범위(M7 가이드 1절 판정표 그대로).
넘는 조건은 heap snapshot 2장 + Comparison 상위 10 + Retainers.
**JS가 평탄한데 Private만 오르면** chrome://tracing memory-infra 1회
(image_cache, gpu, partition_alloc 비중).

### 4. 실행 방식

Start-Process 파이프 문제 해결(스크립트 내부 로그 기록) 승인 — 이후 장시간 측정은 모두 이 방식.
`Start-Process`에 `-RedirectStandardOutput`를 주면 파이프가 열린 채로 남아
호출이 60초를 붙잡는다. **스크립트 안에서 파일로 직접 기록**하고 리다이렉트 없이 띄운다.



1. **B3 (P0, PPT freeze exception)** — 공동편집 중 owner가 아닌 사람이 수동 저장하면
   "Save failed — staying in edit mode" 후 성공 토스트가 뜬다. **→ 수정 완료 (커밋 아래 참조)**

   재현: 상대(owner)가 편집 종료하는 순간 내가 저장.

   원인 (코드 확인됨):
   - `frontend/src/components/file-browser/PptxViewer.tsx` — `persistBytes`가 owner 여부를
     클라이언트에서 미리 보지 않고 곧바로 `collabApi.save(...)`를 호출한다.
   - 서버가 non-owner를 `denied`로 돌려보내 `res.ok === false`.
   - `PptxViewer.tsx:377` — `if (!quiet) showToast.error(res.message ?? 'Save failed')` 로
     "Save failed" 토스트가 뜬다.
   - `PptxViewer.tsx:512-513` — 저장 리스너가 `if (!ok) throw new Error('Save rejected')`.
     수동 저장은 `quiet: true`로 들어오므로 377의 토스트는 막히고 이 경로로만 번진다.
   - `PptxViewer.tsx:528` — catch가 `officeSaveDone { ok: false }`를 뿌려
     `DocumentPreview.tsx:500`의 'Save failed — staying in edit mode'이 표시된다.

   수정: `decideSaveIntent`(신규 `frontend/src/lib/collabSaveIntent.ts`)로 저장 전에 판정한다.
   owner 미확정은 meta를 최대 3초 대기해 재판정하고, owner가 아니면 API를 부르지 않고
   위임 성공으로 처리한다(토스트 1개). owner인데 denied면 meta 1회 대기 후 1회만 재시도한다.

   검증: `frontend/test/collabSaveIntent.test.ts` 5케이스.
   수정 전 게이트(항상 persist)로 돌리면 **3 failed / 2 passed**로 실패함을 확인했다.
   수정 후 **5 passed**. 전체 단위 435 passed(기준선 430 + 5), tsc 에러 0, lint 330 유지.

   ⚠ E21 E2E(`e2e/collab/pptx-collab.spec.ts`)는 추가했지만 **이 PC에서 실행 확인하지 못했다** —
   아래 "E2E 하네스 장애" 참조.

2. **M7 — PPT 열어 둔 상태 메모리 증가 + 원격 마우스 커서 제거** (P0, PPT freeze exception: 메모리)
   커서 제거는 **착수 완료(D26)**, 원인 측정은 **아직** — 커서를 끄는 것과
   "계속 늘어나는 원인"은 별개다. 커서를 꺼도 S0(혼자)에서 늘면 뷰어 자체 문제다.

   **용어 정정**: 마우스/선택 presence는 SSE가 아니라 **collab WebSocket awareness(type 1)**다.
   SSE 설정과 무관. 보고에서 "SSE"로 쓰지 말 것.

   측정은 각 조건 10분, 1분 간격 `__memFloor()` + GC 버튼 후 heap 기록:

   | ID | 조건 |
   |---|---|
   | S0 | solo 보기(공동편집 끔: `?collab=0` 플래그 신설 필요, 기본 on) |
   | S1 | 공동편집 on, 혼자 |
   | S2 | 상대 1명 접속, 둘 다 가만히 |
   | S3 | 상대가 마우스만 계속 움직임 |
   | S4 | 상대가 텍스트 편집 1분 간격 |
   | S5 | 내가 owner로 편집(write-back 발생) |

   판정: S0부터 증가 → lib 렌더러/래퍼(공동편집 무관). S3에서만 → awareness 경로.
   S4/S5에서만 → Y.Doc 업데이트·undo 히스토리·write-back 직렬화.
   증가 조건마다 heap snapshot 2장(0분/10분) Comparison 상위 10 + Retainers 첨부.

   측정 도구는 커서 제거 커밋에 함께 들어갔다: `__collabDebug.awarenessTx/awarenessRx`
   누적 카운터. S3에서 상대가 마우스를 움직여도 내 `awarenessRx`가 거의 늘지 않아야 한다.
   **`?collab=0` 플래그는 아직 없다 — S0 측정에 필요해 먼저 만드는 게 좋다.**

   열린 상태 증가 후보(근거 줄 번호가 지목하는 것만 고친다 — 추측 수정 금지):
   1. lib undo/redo 스택: 원격 업데이트·write-back이 히스토리에 쌓이는지, 상한 있는지.
   2. onContentChange마다 getContent() 전체 직렬화 잔존 여부. write-back은 debounce 경로에서만 직렬화.
   3. write-back 바이트 보관처. sha256Hex의 `new Uint8Array` 복사 제거(subarray/원본 버퍼).
   4. `ensurePptxImagesSyncable()`이 모듈 최상위에서 항상 적용 → solo/보기 전용에선
      불필요한 base64(+33%). 공동편집 세션일 때만 적용 가능한지 lib 근거로 확인할 것.
   5. Y.Doc `gc` 설정 확인, 이미지 이동·편집 시 update 바이트 크기 기록(W3).
   6. lib 10초 presence 재게시(`chunk-552NAFTD.js:408-423`)가 수신 측 전체 리렌더를 유발하는지.
   7. `DocumentPreview.tsx` 1초 interval이 저장 대기 표시 중에만 도는지.

   완료 기준: S0~S5 표 첨부, 전 조건 10분 GC 바닥선 증가 ≤ 5MB, 초기 피크 ≤ 500MB,
   커서 제거 테스트 + PPT E2E 전체 회귀(chromium + msedge, `--repeat-each=3`).

3. **M6 보완** — `e2e/collab/viewer-unmount.spec.ts:135`의 소켓 단언이
   `toBeLessThanOrEqual(1)`이라 느슨하다(닫은 뒤 0이어야 함).
   M6c(시트/다이얼로그 닫기), xlsx/docx 닫기 각 1회 추가.
   사용자 확인: 닫은 뒤 viewer-root 0, sockets 0, GC 후 5분 heap 증가 < 5MB.
   열어 둔 채로도 계속 늘면 M7의 lib 내부 항목(M7)으로 분리하고 heap snapshot retainers 첨부.

4. **B1** — X-B1(xlsx Edit 20회, 편집 UI 표시 실패 0) 실행 결과 보고. b07b49b 하네스 기준.
   2026-10-19 chromium 기준 **1 passed (1.5m)** 로 재현 확인했다. msedge는 미확인.

5. **XLSX 공동편집** — X0a~X0f(라운드트립, 탭 2개, 30초 무쓰기, room_reset, owner meta 1초) → X1~X9.
   설계 기록은 `docs/collab-xlsx-docx.md`에 신설(아직 없음).

6. **DOCX** — D1~D9 (XLSX 완료 후).

7. **태그** — 검증 묶음 통과 후 버전 bump + exe 빌드.

## E2E 하네스 장애 (2026-10-19 실측) — PPT 스펙 전체가 이 환경에서 실행 불가

`e2e/collab/pptx-collab.spec.ts`의 **모든 테스트**가 `openFile`에서 실패한다.
E21만의 문제가 아니다. 근거:

- `E1: participants` (수정 전 코드 그대로) → `locator.click: Timeout`으로 실패.
- `X-B1` (xlsx-solo) → **1 passed (1.5m)**.

차이는 fixture 생성 시점이다. `playwright.config.ts:12-16`이 이미 경고하고 있는 그대로다.

> 백엔드는 시작 시 저장소 트리를 스캔해 children 을 채운다. children 이 `[]` 로 스캔된 폴더는
> needFetch=false 이므로 이후에 파일을 심어도 절대 다시 조회되지 않는다.

- X-B1은 서버 뜨기 **전에** 심은 `probe-seeded-before-server.xlsx`를 연다 → 통과.
- `pptx-collab.spec.ts`의 `freshFile()`은 **테스트 실행 중**에 파일을 만든다
  (`helpers/env.ts:11-14` → `repos/collab-e2e/<slug>-<stamp>-<i>.pptx`) → 트리에 안 뜬다.

추가로 이 PC의 저장소 경로에 공백이 있어(`C:\Users\oh\Documents\Default Project\...`)
`bun run test:e2e:collab` 스크립트가 깨진다:
`'C:\Users\oh\Documents\Default' is not recognized as an internal or external command`.
`npx playwright test -c e2e/collab/playwright.config.ts`로 직접 호출해야 한다.

→ E2E는 공백 없는 경로의 PC에서 돌리거나, `freshFile`을 서버 기동 전 시딩으로 바꾸고
   재실행해야 한다. 그전까지 E2E 통과로 보고하지 말 것.


## 정리 대상 (작음, 별도 커밋)
- `frontend/src/api/collab.ts:191-192`의 `resetRoom` 제거. `/api/collab/reset-room` 라우트는
  백엔드에 없다 — `backend/src/routes/collab.ts`가 `/session`·`/save`·`/handoff`·`/lock`·`/rooms`·
  `/suggest-name`만 등록한다(스키마도 `collab.ts:40`에서 이미 제거됨). **죽은 코드.**
- 세션 effect의 `if (!user) return` 경로에 cleanup(dead=true) 추가.

## v0.13 목록
- 이미지 part 참조 전환(Y.Doc 이중 저장, 이미지 이동 시 update 바이트 측정 W3 선행)
- usePeers의 legacy userName/userColor fallback 제거
- docx/xlsx 코멘트 저장 이름이 collab 개명을 따라가지 않는 문제(TODO(v0.13))
- P2-4 base64 경로 잔재 정리
- `/handoff` 410 스텁 처리(Q01)
- backfilledIds 상한(retainers가 지목할 때만)
