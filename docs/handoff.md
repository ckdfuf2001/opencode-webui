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

**M16 결과 (앵커 폐기 → lib 패치로 해결)**

| 항목 | 결과 |
|---|---|
| lib 조사 | `chunk-552NAFTD.js:11437-11440` cleanup 이 `scheduler.cancel()` → **리마운트/role 변경 때 예약된 write-back 이 버려짐**(=유실 원인 확정). `:11451` 은 owner 일 때만 전달. 스케줄러는 `ooxml-ui/dist/pptx/chunk-MCHPNO42.mjs:33003`. 바이트 출처는 `deps.serialize`/`getSourceBytes` → **DOM 불필요**. |
| 패치 | `ooxml-ui` 에 `flush()` 추가(예약 유지 + **300ms 지연 실행**), `pptx-react-viewer` cleanup 을 **이전 role 이 owner 일 때만 flush** 로 교체. `pnpm patch` 로 영속화(`package.json` 의 `patchedDependencies`). |
| 앵커 폐기 | `commitAnchor.ts`·`waitCommitApplied`·`bytesEqual`·getContent 루프 **전부 삭제**. 수동 저장 경로는 `getContent` 1회로 복원. |
| 테스트 | **E2 통과, E2b 통과, E2c 통과**(chromium·msedge). **E4 실패**(2건) — 동시 편집 시나리오, 남은 과제 |
| 기준선 | relay 17/17, 478 passed, tsc 0, check:memory 오류 0 |

**M15 → M16 앵커 폐기 사유(재발 방지)**
- 앵커는 "마지막으로 실행된 write-back" ⇒ Escape 시점의 커밋 write-back(예약 상태)과 다르다.
- 바이트가 같아지면 오히려 구 내용을 "반영 완료"로 오판한다.
- 직렬화 시점마다 바이트가 달라(8145→8140) **정상 저장까지 전부 타임아웃**된다.
- 앵커 Map 은 경로마다 파일 전체 사본을 영구 보관했다(메모리 규칙 위반, 47MB 덱이면 47MB 누적).
⇒ 앵커/바이트 비교 방식은 사용하지 않는다.

**M17 결과**

| 항목 | 결과 |
|---|---|
| ① 인코딩 게이트 | `scripts/check-encoding.mjs` 추가(U+FFFD·BOM·한글 위치 연속 `?`·한자 혼입 경고). `pnpm check:encoding`, `pnpm test` 선행, PR 템플릿 체크박스, AGENTS.md 금지 규칙 보강. 의도적 위반 1줄 → **EXIT=1** 확인, 정상 → 0. |
| ② flush 안전성 | 300ms 고정 지연 → **조건 기반**(로컬 편집이 Y.Doc 에 반영된 `update`(origin=`LOCAL_SYNC_ORIGIN`) 뒤 실행, 없으면 상한 2초 + 로그). `catch{}` → `console.error` 로 실패 노출. lib cleanup 을 **언마운트 전용**으로 분리(세션/role/doc 교체 시엔 cancel 유지 = 4001 리셋 무효화 방지). owner 판정은 스케줄러가(`pendingConfig.role`). |
| 테스트 | **E2·E2b·E2c 통과**(chromium·msedge), **E4 실패** 2건. |
| 기준선 | relay 17/17, 478 passed, tsc 0, check:memory 0, check:encoding 0 |

**E4 실패 원인 확정(3절 판정표 적용)**: 단언 `[data-testid="collab-peer"][data-owner="true"]` 개수가 **0**(기대 1).
- 저장 0건 아님(편집 반영 단언은 통과), 마지막 저장 내용 문제 아님.
- ⇒ **2인 동시 편집에서 owner 표시가 아예 없음** — 서버 owner 선출(첫 conn=owner)과 connMode 규칙 문제이며
  flush 패치와는 **별개**의 앱 이슈. → 다음 세션 과제(2인 owner 선출).

**M18 결과**

| 항목 | 결과 |
|---|---|
| ① E4 원인 확정 | **owner 가드 붕괴 아님**. 서버 `checkSave`(`collab-rooms.ts:691`)가 `isCurrentOwner` 로 409 `not_owner` 를 막는다. E4 에서 편집 반영은 통과(=저장은 됐음) → **서버 owner 는 존재했고 화면 `data-owner="true"` 표시만 0개** ⇒ 1절 표의 **(가) UI 표시 버그**. (E4 는 2인 모두 편집 모드 → "view 는 owner 불가" 설명은 성립 안 함.) |
| ② 세션 교체/언마운트 구분 | lib effect **두 개**: (1) 언마운트 전용(`deps:[scheduler]`) → `flush()`, (2) **원래 cancel effect 되살림**(`deps:[scheduler,doc,role,hasWriteBack,externalSession]`) → 문서/role/세션 교체 시 cancel. owner 여부는 스케줄러가(`pendingConfig.role`). **4001 리셋은 앱이 `flushOnUnmount=false` 로 알림**(PptxViewer `onReset` → `resetInFlightRef` → config) → 리셋이면 예약 취소. |
| ③ flush 실행 조건 | 로컬 Y.Doc update(origin=`LOCAL_SYNC_ORIGIN`) 뒤 실행, 없으면 상한 2초 + 로그. (300ms 고정 지연 폐기) |
| 테스트 | **E2·E2b·E2c 6건 통과**(chromium·msedge). E4 실패 2건은 ①의 UI 표시 문제. |
| 기준선 | relay 17/17, 478 passed, tsc 0, check:memory 0, check:encoding 0 |

**M18 에서 바로잡은 것(자기 보고서 오류)**: 앞 보고서에서 "role/doc 교체 시 기존 cancel() 유지"라고 적었으나
**실제로는 원래 effect 를 대체해버려 cancel 이 사라졌다**(M18 리뷰 지적이 정확함).
⇒ effect 두 개로 복구(위 ②). 4001 리셋은 리마운트 경로라 "언마운트 전용" 만으로는 막히지 않아,
**앱이 lib 에 알려 주는 구조**(`flushOnUnmount`)로 해결.

**M19 결과**

| 항목 | 결과 |
|---|---|
| ① 실제 저장 경로 증명 | **미완**. lib 계측(`wb.flush.start/run/skip/deadline`, `wb.flush.unmount`)을 패치에 넣고 E2b를 1회 돌렸으나 **lib 로그가 하나도 수집되지 않았다**. 앱 로그(`[collab-tl]` 이벤트)는 정상 수집됨. ⇒ (가) lib 의 `console.debug` 가 이 환경에서 안 잡힘, (b) flush cleanup 이 호출되지 않음 — **둘 중 어느 것인지 미확정**. E2b 통과 시점의 저장은 `save.response`(Escape 후 2.5초) 로 보이며 **lib debounce 경로일 가능성이 높다**(flush 아님). |
| ② flush 무효화 수정 | 패치에 반영: flush 가 **자체 토큰** 사용(scheduler generation 분리) → `cancel()` 에 무효화되지 않음. lib cleanup 2개: (1) 언마운트 전용(`unmountingRef=true` 후 `flush({allow})`), (2) 문서/role/세션 교체 시 cancel(언마운트가 아닐 때만). `flushOnUnmount` 은 **최신 config** 에서 읽음. `abortFlush()` 추가. skip 사유 로깅(조용한 반환 제거). |
| ③/④ | **미구현** (2-3 pendingSave/2-4 registry destroy 지연/Done 경로 2초 측정). |
| 테스트 | E2b 1회 통과. E2/E2c 는 이번 세션에서 재실행 못 함(컨텍스트 소진). |
| 기준선 | relay 17/17, 478 passed, tsc 0, check:memory 0, check:encoding 0 |

**M19에서 발견한 새 사실(중요)**
- `frontend/node_modules` 에 **`ooxml-ui` 링크가 없다**(ooxml-core 만 있음). `pptx-react-viewer` 의 의존성인데
  pnpm 설치가 불완전하거나 링크가 다른 위치로 resolving 된다 ⇒ **런타임이 어느 ooxml-ui 사본을 쓰는지 확정되지 않는다.**
  이것이 lib 로그가 안 잡히는 유력한 원인이며, 리뷰 5절(패치 고정)의 실체다.
- `node_modules/.pnpm` 에 `ooxml-ui@1.8.0_patch_hash=…` 사본이 **여러 개**(오래된 해시 포함) 공존한다.
  `pnpm install --force` 로 새 해시가 생기지만 프론트 링크가 갱신되지 않는 경우가 있었다.

**M20 결과 — lib 로그 미수집의 원인 확정**

| 조사 | 결과 |
|---|---|
| 1-1 사본 전수 | `ooxml-ui` **6벌**(5 patched 해시 + 1 원본), `pptx-react-viewer` **4벌**(1 patched(`ffxbnvob…`) + 3 옛). `useCollaborationWriteBack` 훅은 pptx-react-viewer 사본에만 존재(hook=2), 스케줄러는 ooxml-ui 쪽(scheduler=2). |
| 1-3 런타임 표식 | `globalThis.__ooxmlPatches` = **null** ⇒ **런타임에 패치가 로드되지 않았다**. E2E 시작 조건으로 단언 추가(실패 시 즉시 중단). |
| 1-2 앱의 import 출처 | `.vite/deps/pptx-react-viewer.js` 는 `chunk-KR2P4QND.js`(ooxml-ui 쪽)에서 심벌을 가져온다. **뷰어 훅이 실제로 들어있는 코드는 ooxml-ui/pptx 쪽**이고, **`pptx-react-viewer/dist/chunk-552NAFTD.js` 는 앱이 로드하지 않는다**. Vite 사전 번들에서도 `chunk-KR2P4QND.js` 에만 표식이 있고 `pptx-react-viewer.js` 에는 없다. |
| 1-4 Vite 캐시 | `frontend/node_modules/.vite` 삭제 후에도 표식 없음 ⇒ (가)Vite 캐시 아님. |

⇒ **M16~M19 의 lib 패치(cleanup flush)는 전부 무효였다.** 리뷰 예상 (나)"다른 사본"이 맞다.
⇒ **다음 세션 1순위**: `ooxml-ui/pptx` 안의 실제 뷰어 훅 파일을 찾아 **그 파일에** cleanup 패치를 적용하고,
   1-3 표식 단언이 통과할 때까지 반복. 그 뒤에야 M19 1절(저장 경로 증명)·2절(예약 없는 flush)·3절(앱 await) 진행.

**M21 결과 — lib 패치 대상 파일 확정(큰 진전)**

| 조사 | 결과 |
|---|---|
| 1-2 exports | `pptx-react-viewer`: `import` → **`dist/index.mjs`**, `require` → `dist/index.js` (CJS). **Vite(브라우저 ESM)는 `.mjs` 빌드를 쓴다.** |
| 1-4 훅 위치 | ESM: **`dist/chunk-DD3ARHEW.mjs:11418`** / CJS: `dist/chunk-552NAFTD.js:11425` ⇒ **훅 패치는 CJS에 붙어 있었고(무효), ESM이 실제 로드 파일.** |
| 1-5 sourcemap | `.vite/deps/chunk-KR2P4QND.js.map` sources → `ooxml-ui@1.8.0_patch_hash=uqul4e7…/dist/pptx/chunk-A63ASSCH.mjs` 등 ⇒ **스케줄러는 ooxml-ui 쪽이므로 그 패치는 유효** (리뷰 4번과 일치). |
| 1-1 표식 단언 | **ui/viewer 둘 다 `M21`** ⇒ 판정표 3행 "패치 유효". (확인 시점은 파일을 연 뒤로 이동 — 동적 import라 그 전엔 null 이 정상.) |
| 1-5 저장 경로 | E2/E2b 의 저장은 `save.response` 2회, flush 는 **`wb.flush.skip {reason:"deadline"}`** ⇒ 저장은 **lib debounce 경로**. flush 는 2초 내 로컬 update 가 없어 **저장하지 않았다**(구 내용 덮어쓰기 방지). |

**이번에 고친 것**
1. **ESM 훅 파일에 M19 훅 패치 적용**(`chunk-DD3ARHEW.mjs`) — 언마운트 flush + `unmountingRef` + 최신 `flushOnUnmount`.
2. **표식 위치 수정**(결함 3): CJS 는 `'use strict'` 뒤, ooxml-ui 는 마지막 import 뒤. 표식값 `M21` 통일.
3. **fire() own 버그 수정**: `fire()` 가 `abortFlush()`(flushState=null)를 먼저 호출해 `run()` 의 `isCurrent()` 가 항상 false → **저장이 항상 skip(not_current)** 이던 것. 리스너/타이머만 정리하도록 변경.
4. **deadline 경로에서 저장 금지**(M20 2절): 2초 내 로컬 update 가 없으면 **저장하지 않고** `wb.flush.skip {reason:"deadline"}` + 경고 로그. (실측: deadline 에서 실행하면 커밋 반영 전 Y.Doc 을 저장해 **구 내용으로 덮어씀** = 조용한 유실. E2b 가 이걸로 깨지는 것을 확인하고 바로잡음.)
5. E2E: E2/E2b 2건 통과, flush 로그 수집 확인.

**M16~M19 재검토표**

| 관찰 | 의존 대상 | 당시 로드 여부 | 판정 |
|---|---|---|---|
| M16 "즉시 실행 시 8141B(커밋 전)" | 스케줄러 | 유효(ESM) | **재측정 필요**(flush가 실제로 저장하는 경우) |
| M17 조건 기반 flush(로컬 update 뒤 실행) | 스케줄러 | 유효 | **재측정 필요**(update 멈춤 시점) |
| M18/M19 언마운트 flush · 4001 보호 | **훅(CJS에 붙음)** | **무효** | **M21에서 ESM에 재적용 → 이번에 로그 확인됨** |
| E2b 통과 | 훅(무효) | — | **lib debounce 경로로 통과**(flush 아님) |
| "M16~M19 전부 무효" | — | — | **과잉 결론 — 스케줄러 패치는 유효. 훅 패치만 무효였음.** |

**남은 과제(다음 세션)**
1. **M20 2절 나머지** — "미동기 편집" 판정( lib 모델에 있지만 Y.Doc 에 안 보낸 편집) 을 dist 에서 찾아 파일:줄로,
   없으면 즉시 실행. 그리고 **update 가 멈췄을 때** 실행(여러 transaction 대응) + 상한 초과 시 실패 처리(현재 deadline 스킵 ✓).
2. **M20 3절(2-3/2-4)** — 경로별 pendingSave promise(바이트 미보관) + endEditing await(3초) +
   registry destroy 3초 유예 + `collab:writeback-failed` 전역 이벤트(토스트·내 사본 다운로드) +
   4001 시 `abortFlush` 직접 호출.
3. **E2f/E2g/E2h 신설**(T1a) + scheduler/hook 단위 테스트 + E4 실측표(서버 owner vs 화면 data-owner).
4. **5절 고정** — `patchedDependencies` 키 버전 고정(`pptx-react-viewer@4.33.0`): pnpm 이 루트 의존성에서
   키를 찾지 못해 실패했다(프론트 의존이라 루트에 없음). ⇒ frontend 의 specifier 고정("4.33.0", 캐럿 제거 ✓) +
   루트 devDependencies 에 동일 버전 추가(사본 1개 증가) 또는 pnpm-workspace.yaml 의 patchedDependencies 사용 검토.
   **빌드 표식 검사**(prod exe 번들 grep) 스크립트 추가.
5. E2d, E2e(D39), `fileFullscreenChange` grep, 인코딩 게이트 범위(origin/main...HEAD + staged + untracked).
6. E2/E2b/E2c/E4/E2d~E2h × chromium·msedge `--repeat-each=3` + E19/E19b/E20 무회귀, throttle 4× E2b 5회.

**M15 추가 발견 (lib dist 확인)**
- lib `chunk-552NAFTD.js:11423` `useCollaborationWriteBack`: write-back 은 `scheduler.schedule()` 로 예약되고
  **role==="owner" 일 때만** 전달된다(:11451). 예약은 `useEffect(() => () => scheduler.cancel(), [.., input.config?.role, ..])`(:11437-11440)
  → **role/doc 이 바뀌면 예약이 취소**된다.
- 앵커(커밋 write-back 바이트)는 **경로별 모듈 싱글턴**(`frontend/src/lib/commitAnchor.ts`)으로 둔다 —
  per-instance ref 로 두면 write-back 인스턴스와 flush 인스턴스가 달라 앵커가 null 이었다(실측).

**M15 검증 결과**
| 대상 | 결과 |
|---|---|
| E2b 단독(chromium) | **통과** |
| E2b+E2+E2c+E4 묶음 | 4 passed / 4 failed — **플레키** |

- E2b: 단독 통과, 묶음 실패 → waitForDisk 는 통과하는데 **'Done' 클릭 후 리마운트 구 내용 write-back 이 편집을 덮어씀**.
- 플러시 대기: 앵커(8140/8144)와 모델(8138/8145) 이 매번 달라 **타임아웃이 반복**된다(직렬화 바이트가 시점마다 다름).
  타임아웃 시 **저장을 건너뛰는** 안전장치 덕분에 유실은 막혔다(그 뒤의 write-back 이 커밋 내용을 저장).

**다음 세션 시작점(구체적)**
1. **직렬화 바이트 비교는 unreliable** → 앵커 비교를 **텍스트 기준**으로(저장 바이트에서 도형 텍스트 추출).
   lib 에 텍스트/소스 접근이 있는지 dist grep 필요(`getSourceBytes`/`getSaveOptions` 흔적).
2. **리마운트 후 구 내용 write-back 차단** — 직전 성공 저장(newHash) 이후 리마운트가 있었으면,
   리마운트 직후 첫 auto 저장은 직전 저장과 동일할 때만 허용(또는 직전 저장 해시와 비교).
3. **E2b 플레키 원인** — 단독 통과/묶음 실패. 직전 테스트가 남긴 상태(백엔드 방/owner, 파일 캐시) 확인.
4. E2d(PPT/XLSX 동시 편집 — B1(b) 재발 검사) 미작성.
5. 정상 실행에서 `flush.commit_wait_timeout` **0회**여야 함(2절 조건) — 현재 2회.


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
- `ooxml-core` 서버측 편집 API와 MCP를 조사한다. 쓰기는 `/api/collab/save`를 거치거나, 방이 열려 있으면 막는다. D48 외부 변경 동기화와 연결.

## PPT 저장 트랙 종료 (v0.12.70, 기준 커밋 f129575)
- 종료 테스트 5개(E2·E2b·E2f-strict·E2g·E2r)가 chromium 15/15 + msedge 15/15 = **30 passed (14.7m)**.
- 기준 커밋 `f129575` (main = release-0.12 동일 해시). 태그 `v0.12.70`.
- 판정 (가): 편집 화면이 `fixed inset-0 z-[100]` 로 전체를 덮어 닫기 버튼이 클릭 불가 → 앱은 정상.
  사용자가 실제로 가장 빨리 닫는 경로는 "Done/Escape(`endEditing`) → 곧바로 닫기" 이며 E2f-strict 가 검증한다.
- **언마운트 flush 경로(M31 grace 포함)는 미검증 안전망** — 사용자가 닿을 수 없는 경로이며 검증 대상이 아니다.
- M34 닫기 가드는 M36 에서 revert(비소유자가 미리보기를 닫지 못하는 실사용 회귀).
- 후속 트랙: XLSX(X0a~) — 종료 테스트를 먼저 정의하고, PPT에서 겪은 함정(CJS/ESM 이중화 D42,
  scheduler `cancel`, superseded 참조 비교)을 XLSX dist 에서 줄 번호와 함께 조사한다.

## 백엔드 대기 트랙 (B0, 2026-10-22, 커밋 611857a·4070622)

사용자 지적: "opencode 단에서는 정상 종료했는데, 우리 백단은 계속 대기한다. 서버에서 타이머가 있어야 한다."

### 실측 근거 (사용 중 exe 백엔드 로그, `GET /api/system/logs`)
```
11:11:25 [warn] Queued chat flush errored for session ses_e9cc3e126ffextfB3DMMGLw3Jx: {}
11:16:38 [warn] Queued chat for session ses_e9cc3e126ffextfB3DMMGLw3Jx stuck in sending for 10min (still busy).
11:30:57 [info] Confirmed queued chat delivered to session ses_ee4721a3dffey6wY8ulCCen1I7 (idle observed)
```
- 큐 발송이 "sending" 에 10분 고착 → 600초(`SEND_HEADERS_TIMEOUT_MS`)까지 백단이 대기.
- 원인 로그가 `{}` 라 **타임아웃인지 단절인지 구분 불가**(AbortError/TimeoutError 는 DOMException).

### B0-1 (611857a) — 에러 원인 노출
- 근본: `logger` 의 링 버퍼 직렬화가 Error 를 `JSON.stringify` → DOMException 은 `{}`.
- 수정: `backend/src/utils/error-detail.ts` 추가 + `logger.serializeArg` 가 Error 를 name/message/code/cause 로 펼친다
  (백엔드 100여 개 `logger.warn(msg, error)` 호출부가 한 번에 정상화). 큐 발송 로그에 경과시간 추가.
- 회귀 테스트: `backend/test/utils/logger.test.ts`(4) + `error-detail.test.ts`(8).
  수정 전 실패 원문: `expected 'Queued chat flush errored for session ...' not to contain '{}'`.

### B0-2 (4070622) — 턴 종료 확인 시 업스트림 요청 중단
- 수정: 세션 상태 폴러(1초 주기)가 이미 관측하는 busy/idle 을 재사용(새 폴링 없음).
  발송 이후 "busy 관측 → idle 관측"이 확인되면(턴 종료) 붙어 있는 /message 요청을 abort → 대기가 즉시 끝난다.
- 안전장치: ① busy 를 한 번도 관측하지 못한 세션은 끊지 않는다(오발 방지)
  ② 발송 중에는 큐 항목을 제거하지 않는다(발송 실패 시 메시지 유실 방지)
  ③ 우리가 끊은 요청은 오류가 아니라 정상 종료로 기록.
- 회귀 테스트: `backend/test/services/chat-queue-turn-end.test.ts`(2).
  수정 전 실패 원문: `expected false to be true` (업스트림 미중단).

### 남은 백로그 (B0 후속)
- **직접전송 경로(proxy)**: `backend/src/services/proxy.ts` 는 업스트림 fetch 에
  `AbortSignal.timeout(600_000)` 만 걸고 클라이언트 단절을 전파하지 않는다. 전파하면
  **탭을 닫거나 페이지를 옮길 때 진행 중이던 턴이 죽는다**(opencode 는 클라이언트
  단절을 받으면 턴을 정리) → 채택하지 않음. 대신 턴 종료 감지로 한정.
  - B0-3(2026-10-28): 큐와 같은 규칙을 proxy 경로에도 적용했다. 발송 이후 busy 관측 →
    idle 관측이면 붙어 있는 업스트림 요청을 abort 하고, 우리가 끊은 경우는 정상 종료로
    기록한다(헤더 미발송이면 합성 200). busy 미관측이면 끊지 않는다.
- `recordTransientTimeout` 은 계속 queued 유지 + 자동 재시도(무한 루프 가능) — 의도된 설계(문서 참고).

### B0 후속 트랙 결과 (B0-3 · B0-5 · B0-6, 2026-10-28)
- 1절 원인 확인:
  - SSE off bash 타일 미표시 = 렌더 분기 문제(나). 폴링 응답은 모드와 무관하게 동일하고
    (`useMessages` SSE 분기 없음), running part의 `input.command`는 opencode DB에 있다.
    (가)는 64KB 초과 capped 경로에서 `input`이 빠지는 잠재 결함으로 확인 → B0-5에서 보존.
    (다)는 기각 — `sameMessageContent`가 running 개수를 비교하므로 pending→running 전이는
    검출된다. 진짜 누락 지점은 last-message 병합 가드(같은 출력에 상태 뒤집힘이 묻히면 유지).
    증거: 실DB running part 원문(`state.input.command` 포함), `/session/status` busy 원문,
    우리 recent·DB 대조(3원문 일치 — 턴 진행 중이라 모두 running/busy).
  - 실행 중 잔류: 우리 DB busy는 1초 폴러가 정정(잔류 안 함). 큐 sending·in-flight는
    인메모리(재시작 소멸). proxy in-flight는 600초까지 잔류 가능 → B0-3 대상.
    opencode 자체 part는 수십 건 고착 확인(최대 82일, 손대지 않음) → B0-6 표시로 처리.
- B0-5: SSE off 미완료 툴 full 타일 통일 + capped input 보존(32KB) + equality 상태서명 +
  merge 가드 교체. 타일은 명령어 표시, 고아는 "종료됨 · 응답 없음".
- B0-6: 1분 sweep 유지. 세션 정리는 idle 2회 연속, part 정리는 running + 세션 idle 2회
  연속에만 orphan 표시(busy는 손대지 않음, abort 없음). opencode 완료 part의 표시는
  즉시 치우고 part-mismatch 경고.
- B0 재수정(P0-2 · P1-1~P1-4 · P2, 2026-10-28): 턴 판정을 폴러 스냅샷으로 교체(전역 단독
  조회는 레포 busy를 빠뜨려 오판 — 실측 확인). backend tsc 47은 c21c335에서 같은
  집합으로 확인돼 기존 것으로 판정(X1c의 0은 다른 범위 측정). 고아 쿼리에 24h 하한 +
  배치 재사용, 표시된 고아 재표시 금지, proxy abort 3초 유예, merge 순서 가드.
  매 틱은 pumpTrackedIdle 하나로 처리(busy→noteProxyBusy, idle→유예 뒤 abort,
  unknown→유예 취소). directory 미상·'global'은 unknown(전역 세션은 600초 timeout 의존).
  P1-a red는 unknown 분기 무력화로 동작 확인(유예 미재시작 시 3.5초 idle에 중단됨).
  X0a-9 red는 9bc434e에서 신 단언 실행으로 확보.
- 관련 커밋: D46 재재수정 참조.

### 환경 주의 (이 저장소에서 신규 파일 추가 방법)
- `opencode-webui` 의 repo-tracking 기능이 `.git/info/exclude` 에 `/*` + `!/.opencode` + `!/scripts` 를
  관리한다(backend/src/services/repo-tracking.ts:23). ⇒ **신규 파일은 `git add -f` 로 추가해야 한다**
  (추적 중인 파일은 영향 없음).

### 기준선 갱신 (2026-10-22 실측)
| 항목 | 명령 | 실측값 |
|---|---|---|
| 단위+프론트 | `pnpm -C backend test -- run` | **49 passed / 3 failed suite** (52 파일) |
| 타입 | `pnpm -C frontend exec tsc -b` | 에러 0 |
| 린트 | `pnpm -C frontend exec eslint .` | **333 problems (272 errors, 61 warnings)** |
| 메모리 규칙 | `pnpm check:memory` | 오류 0 |
| 인코딩 | `pnpm check:encoding` | 오류 0 |

- 실패 3개: `backend/test/services/config-migration.test.ts`, `backend/test/services/repo-tracking.test.ts`
  (둘 다 `bun:sqlite` 미설치) + **`frontend/test/collabSessionRegistry.test.ts` (5건)**.
- collabSessionRegistry 실패는 **M31(2641090)의 3초 유예**와 테스트의 동기 기대값 불일치다
  (테스트는 release 직후 즉시 destroy 를 가정: `frontend/test/collabSessionRegistry.test.ts:25,40,60,72,91`
  vs `frontend/src/lib/collabSessionRegistry.ts:95-122`). v0.12.70 기준선 문서(469 passed/2 failed)는
  M31 이전 측정치다 ⇒ **기준선 문서 갱신 필요(백로그)**.

## UI 개편 트랙 U1~U3 (2026-10-22 완료)

- U1 (8519875): 데스크톱 `Close preview` 버튼 제거. 닫기 = 탐색기 접기(패널 언마운트 →
  미리보기/뷰어/소켓 정리). `FileBrowserSheet`/`SessionFilePanel` X 버튼에
  `aria-label="Close explorer"` 추가. `e2e/collab/helpers/viewer.ts` 의 `closePreview` 가 이 경로를 쓴다.
- U2 (7e737da): 편집 모드 액션(Done/Save/Comments)을 **PPT 타이틀바의 기존 `actions` 슬롯**
  (기능 search 오른쪽, `.end` 영역)에 투영. lib 패치 2개:
  - `pptx-react-viewer`: `titleBarSlot` prop → `TitleBar` children → `<div slot="actions">`.
    루트 `dist/index.d.ts` 와 `dist/viewer/index.d.ts` 둘 다 타입 추가(둘 다 자체 사본을 가진다).
  - `ooxml-ui`: `autosave.available === false` 면 AutoSave 표시를 숨긴다.
  - **교훈**: PPT 는 베이스 `office-ui-title-bar`(chunk-O7APCA5N)가 아니라
    `chunk-MCHPNO42.mjs` 의 자체 사본 + `PptxTitleBar` 를 쓴다. 베이스에 슬롯을 추가해도
    PPT 에는 반영되지 않는다(디버그로 확인). 기존 `actions` 슬롯을 쓰면 슬롯 패치가 필요 없다.
- U3 (c13b912): 편집 모드 전체화면 + 헤더 숨김. 단, XLSX/DOCX 는 타이틀바 슬롯이 없어
  `DocumentPreview` 헤더를 유지한다(PPT 만 헤더 숨김) — v0.13 에서 xlsx/docx 슬롯 지원 검토.
- 검증(2026-10-22): `ui-layout.spec.ts` U1/U2/U3 통과, 회귀 E2/E2b/E2f-strict/E2g/E2r/M6a/M6b/X-B1
  통과, `tsc -b` 0, `check:encoding` 0, `check:memory` 0, 프로덕션 빌드에
  `__ooxmlPatches`(ui=M21, viewer=M21-esm) 포함 확인.
- 전수 `pptx-collab.spec.ts` 실행 시 19건 실패(E3 라벨, E21b 원격 커서, E4/E5/E7...).
  U1~U3 변경 경로(타이틀바/미리보기 닫기)와 무관한 **기존 실패로 추정** — 착수 전 기준선이
  부분 스위트만 측정되어 있었다. 다음 세션에서 66edec6 이전 커밋으로 대조 필요.
- **기준선 대조 완료(2026-10-22)**: `git worktree` 로 `v0.12.70` 을 만들고 양쪽에서 동일 명령
  (`pptx-collab.spec.ts`, chromium, workers=1) 실행.
  | 실행 | failed | passed | skipped | did-not-run |
  |---|---|---|---|---|
  | v0.12.70 (base) | 17 | 17 | 1 | 0 |
  | HEAD | 17 | 17 | 1 | 0 |
  실패 이름 집합 동일(E3/E4/E7/E8/E9/E12/E15/E16b/E18/E19b/E20/E20s/E21/E21b + 모바일 3건)
  ⇒ **HEAD-only 회귀 0건**. 전수 실행에서만 보이던 E5 는 재실행 시 통과(플레이크).
  기존 17건은 이번 범위에서 고치지 않고 백로그로 둔다.
- 루트 devDependency `pptx-react-viewer` 제거(버전 키 패치에는 불필요). clean install 후
  lockfile 스냅샷 1개, 설치본 `slot: "actions"`/`M21-esm`/autosave hunk 확인, U1~U3 재통과.
- Save 버튼 경로: `officeSaveRequest → PptxViewer.onSave → getContent → persistBytes →
  saveSerializer.request`(PptxViewer.tsx:735) — serializer 우회 아님.
- M6b 는 U1 로 탐색기가 닫히므로, 반복 주기마다 `Workspace` 로 탐색기를 다시 열도록 수정(20281bf).

## XLSX 동시편집 트랙 X0a/X1a (2026-10-24)

- **아키텍처 차이**: PPT 는 앱이 방(Y.Doc/awareness/owner)을 직접 운영한다. XLSX 는
  ooxml-ui 의 xlsx 편집기가 방을 자체 관리한다(`collaboration` 옵션). 앱은
  `collabApi.session(path)` 로 방을 만들고 `{ roomId, serverUrl: collabServerUrl(), user }` 를 넘긴다.
  백엔드 `/api/collab/:room` 은 y-websocket 호환이고 방마다 `Y.Doc` 을 서버가 들고 있다 ⇒
  나중에 들어온 사람도 방의 문서를 통째로 받는다.
- **구현(553fcbe)**: `DocumentPreview.tsx` 의 `XlsxViewer` 가 편집 모드에서만 방에 참가.
  presence 는 lib 타이틀바(`xve-title-people`)가 자체 표시한다. 저장은 기존 `/api/files` 경로.
- **수용 기준(`e2e/collab/xlsx-collab.spec.ts`)**
  - X0a-1 두 편집자가 같은 방에 들어가고 서로가 보인다 ✓
  - X0a-2 A 의 편집이 B 에 반영되고 B 저장으로 디스크에 남는다 ✓
    (XLSX 그리드는 canvas 렌더라 셀 텍스트를 DOM 으로 못 읽는다 → 저장된 zip 을 풀어 XML 로 확인)
  - X0a-3 디스크와 어긋난 방에는 붙지 않는다 ✓
- **함정(조사 결과)**
  - 방의 문서가 "먼저 들어온 쪽" 기준 ⇒ 낡은 방에 붙으면 디스크의 새 파일이 예전 내용으로 덮어써진다
    → 서버가 stale 로 판정해 막는다(클라이언트도 해시를 못 계산하면 fail-closed 로 붙지 않는다).
  - 코멘트 저장은 파일 바이트를 직접 고쳐 쓰고 뷰어를 재마운트 → 방이 살아 있으면 방의 내용이 이겨
    코멘트가 조용히 사라진다 ⇒ 편집 중 코멘트 버튼을 비활성화.
  - **보기 모드 코멘트가 편집 중인 문서를 덮어쓴다**: 보기 모드는 방에 참가하지 않으므로
    코멘트가 디스크에 바로 저장된다. 그 뒤 편집자가 저장하면 **방 내용(코멘트 없음)** 이 디스크를 덮는다
    ⇒ AI 편집과 같은 종류의 외부 변경이며, X1b 에서 `conflict_external`(409) + 배너 + 내 사본
    다운로드로 막았다. **보기 모드 참가**를 넣기 전까지 이 경로는 계속 열려 있다(백로그).
  - 외부 파일 변경(AI 편집)이 편집 중인 뷰어에 반영되지 않는다. 방 리셋(4001) 처리도 없다.
    백로그: v0.13.
- **회귀**: xlsx-solo(X-B1), ui-layout(U1~U3), viewer-unmount(M6a/M6b) 통과.

## XLSX 동시편집 X1b (2026-10-24)

- 커밋: `0aa90fa`(테스트) → `bb8942c`(백엔드) → `0db32c9`(프론트) → 문서 커밋.
- **P0-1 저장 경로**: XLSX 저장을 `/api/collab/save` 로 통일. 낙관적 잠금(base hash)으로
  `conflict_room`(다른 참가자가 먼저 저장 → 재직렬화 1회 재시도) / `conflict_external`
  (외부 변경 → 재시도 금지, 배너 + 내 사본 다운로드)를 갈라 쓴다. 방의 `lastHash` 가 갱신되어
  뒤에 참가하는 사람이 낡은 방으로 판정되지 않는다.
- **P0-2 fail-closed**: 해시 계산 실패(`crypto.subtle` 없음)면 방에 붙지 않는다. 서버도
  `session(strict)` 로 디스크 해시·`room.lastHash`·`knownHash` 를 비교해 `stale` 코드를 준다.
- **P0-3 정정**: D48 의 "실질적으로 같은 내용" 문장 삭제. base hash 로 옛 바이트의 늦은 도착을 막는다.
- **P0-4 외부 변경**: `conflict_external` 로 덮어쓰지 않고 배너 + 내 사본 다운로드를 띄운다.
- **P1 반영**: `waitForTimeout` 0개(전부 `expect.poll`), 테스트마다 새 파일 사본, X0a-3 은 배너까지 확인,
  편집 중 코멘트 버튼 비활성화, X-M6 추가.
- **저장은 편집을 유지한다**: `keepEditing`. XLSX 는 lib 이 방 세션을 소유하므로 편집기가 내려가면
  방에서 나간다. "Done" 만 편집기를 내리므로 그때 소켓도 내려간다(X-M6).

### X1b 실행 결과 (2026-10-24)

| 항목 | 명령 | 결과 |
|---|---|---|
| XLSX 수용 기준 | `xlsx-collab.spec.ts` chromium+msedge `--repeat-each=3` | **54 passed** (9 tests × 3 × 2) |
| 수정 전 실패 확인 | 같은 스펙 @ `9bc434e` (chromium 1회) | 5 failed / 4 passed (X0a-3·4·6·7, X-M6) |
| 회귀 | `X-B1`, `U1~U3`, `M6a/M6b`, `E2·E2b·E2f-strict·E2g·E2r` (chromium) | **11 passed** |
| 타입 | `pnpm -C frontend exec tsc -b` | 오류 0 |
| 메모리 규칙 | `pnpm check:memory` | 오류 0 (경고 1 = 기존 D36) |
| 인코딩 | `pnpm check:encoding` | 오류 0 |
| 린트 | `pnpm -C frontend exec eslint .` | **333 problems (272 errors, 61 warnings)** = 기준선 |
| 백엔드 | `pnpm -C backend test -- run` | 49 passed / 3 failed suite (bun:sqlite 2 + collabSessionRegistry 5건) = 기준선 |

- E2 는 한 번 3.2초(기준 3초)로 실패했다가 재실행에서 통과했다. 같은 시점에 사용자 앱이
  돌고 있어 CPU 가 몰렸던 것으로, `9bc434e` 워크트리 대조에서도 통과했다 ⇒ 코드 회귀 아님.

### X1c 후속 결과 (2026-10-25)

- 커밋: `31ca9d4`(테스트: X0a-8 단독 저장 잠금, X0a-9 연결 전 차단) → `14c81c2`(백엔드:
  ETag/If-Match, xlsx `baseHash` 필수 400, strict stale fail-closed) → `b1230ec`(프론트:
  `connecting` 차단, 모든 실패 다운로드+Done 확인) → `7cd9b56`(ETag 동기화+따옴표 정규화,
  X0a-9 수렴형 검증) → 문서.
- **X-B1 회귀 원인**: POST `/api/files` 의 If-Match 비교가 따옴표 감싼 ETag(`"..."`) vs 클라이언트
  값(따옴표 없음)의 형식 불일치였다. 서버가 양쪽 따옴표를 벗기고 비교하도록 정규화로 해결.
- **X0a-9 결정화**: 판정(`active&&synced`) 뒤 저장→디스크 확인, 없으면 재입력+재저장을
  반복 폴링으로 수렴시킨다(수식 바 read-back 은 레이스 때문에 신뢰하지 않음).

| 항목 | 명령 | 결과 |
|---|---|---|
| X0a 전체 반복 | `--repeat-each=3` chromium + msedge | **33 passed × 2** |
| X0a-9 반복 | `--repeat-each=3` chromium | 3 passed (409 `conflict_room` → 재직렬화 재시도 200 확인) |
| X-B1 | chromium + msedge | 2 passed |

### X1d 실행 결과 (2026-10-25)

- 커밋: `e402d29`(테스트: X0a-9 차단 확인형, X0a-10 WS 차단 상한, X-B2 DOCX 저장) →
  `e497aa0`(수정: requireIfMatch 범위, 연결 대기 상한 15초, Done 확인 닫힘) → 문서.
- **X0a-9 수정 효과 증명**: 고친 테스트를 webui-pre(`9bc434e`)에서 실행 → 실패 원문:
  `Error: expect(locator).toBeVisible() failed / Locator: getByTestId('xlsx-collab-connecting') /
  Error: element(s) not found` @ xlsx-collab.spec.ts:539.
- **lib 발견(X1d)**: `active` 는 공유 시작의 뜻일 뿐 소켓이 열렸다는 뜻이 아니다.
  잠금 해제 조건을 `active && status==='connected' && synced` 로 강화(X0a-10 에서 검증됐다).

| 항목 | 명령 | 결과 |
|---|---|---|
| X0a + X-B1/X-B2 반복 | `--repeat-each=3` chromium | **42 passed** (14 tests × 3) |
| X0a + X-B1/X-B2 반복 | `--repeat-each=3` msedge | **42 passed** |
| 회귀(U/M/E 트랙) | U1~U3, M6a/M6b, E2·E2b·E2f-strict·E2g·E2r (chromium) | **10 passed** — X-B1·X-B2 는 위 반복 42건에 포함 |
| 타입/메모리/인코딩/린트 | backend tsc, frontend tsc, check:memory, check:encoding, eslint | 0 / 0 / 0(경고1 기준선) / 0 / 333 기준선 |




## pptx-collab 기준선 재확인 (X2a ①, 2026-10-27)

- 명령: 
 `npx playwright test -c e2e/collab/playwright.config.ts --project=chromium e2e/collab/pptx-collab.spec.ts`
- 결과: **failed 18 / passed 16 / skipped 1** (21.7분). 기준선 대비 차이는 E5 1건(D47 플레이크). E11m 3건은 원래 기준선 17건에 포함.
- 실패 이름 18건: E21b, E3, E4, E5, E7, E8, E9, E12, E15, E18, E16b, E19b, E20, E20s, E21, E11m/E1m, E11m/E2m, E11m/E3m.
- 확인: E5 와 E11m 3건은 **c21c335 에서도 실패**(E5 는 플레이크 성격, E11m 3건은 기준선 포함)(백엔드·shared 파일만 c21c335 로 되돌려 재실행, 4 failed). 따라서 X2a ① 이 늘린 실패는 없다.
- E2 계열(E2, E2b, E2f-strict, E2g, E2r) 5건은 전부 통과.
- 한계: 나머지 14건은 c21c335 에서 다시 돌리지 않았다. PPT 경로(app 키, app.mode)는 ① 변경과 분기가 달라서 영향이 없다고 본다.

## X2a-③ 완료 기록 (2026-10-27/28)

- 테스트: `40d2605`(X2a-2,3,4,6,7 + X-M6-ext, red) → 구현 `d4733ee` → `9334d5a`(X-M6 개정)
  → `907066d`(X0a-9 fill 레이스 수정) → `a24388f`(viewer 타임아웃 keep) → `3e7f87b`(X0a-2 반영 대기).
- X2a-2 red → green: viewer-first 는 자기 파일을 보여 주고, 편집자 등장 뒤 리마운트로 방 내용을
  따라간다. 편집값은 디스크와 다르게(X2A2 스탬프) 넣어 구분했다.
- X-M6 개정 사유: Done 뒤 viewer 로 다시 붙어 방이 유지되므로, 기존 단언(편집 종료 즉시 방 해제)은
  과도기 0rooms 폴링에 걸려 우연히 통과했다. 개정판은 Done 뒤 viewer 재참가를 확인하고
  미리보기 닫힘에서 해제를 확인한다. 구 단언은 X-M6-ext(마지막 viewer 퇴장)가 계승한다.
- X0a-9回归 디버깅 기록: programmatic fill 은 lib readOnly 를 우회한다(typed=true 인데도
  방 적용에 지워짐). `inert` 오버레이는 fill 을 막지 못했다(관측). `display:none` 래퍼는
  fill 을 확정 실패시켜(typed=false) 판정 뒤 1회 재입력 경로로 수렴한다. viewer→editor 전환
  구간도 editor 역할 참가까지 잠그고, 모드 전환 시 세션·안내를 초기화한다.
- X0a-2 강화: B 저장 전 A 편집 반영을 먼저 확인한다(선천적 저장-반영 레이스).
- E2 지연 플레이크: 3c8528a 1/4(3621, 3675, 3078, 3174ms) vs HEAD 3/2(3175, 3338ms).
  양쪽 다 같은 3000ms 단언에서 걸리므로 머신 부하로 기록한다. E5 플레이크와는 분리한다.
- X0a+X2a ×3: chromium 65/66(X0a-2 r1만 실패 — B 저장 전 A 반영 대기가 없어 부하 시
  저장-반영 레이스, 테스트를 강화하고 X0a-2 ×3 통과 확인), msedge 66/66.
  회귀 10건(U1~U3, M6a/M6b, E2·E2b·E2f-strict·E2g·E2r) 전부 통과.
- 기준선: frontend tsc 0 · backend tsc 47(기존) · eslint 333(272/61) ·
  check:memory 오류 0/경고 1(D36) · check:encoding 0 ·
  backend vitest 513/513(실패 파일 2개는 bun:sqlite 기존 항목).
- clean install(`NODE_ENV=development`, `npx --yes pnpm@9.15.0 install --frozen-lockfile`,
  EXIT=0): 패치 해시 디렉터리 유지, 표식 4종 런타임 확인(M21·M21-esm은 E2f-strict 의
  openFile 단언, X2a-core-esm·X2a-ui는 X2a-1 단언).

## C1 접속자 표시 통일 (2026-10-29, release-0.12)

- red: e2e/collab/presence.spec.ts P-1~P-4 (testMatch 등록). P-1/P-4 red 원문 확보
  (collab-presence 없음 / 표식 null), P-2/P-3은 구조상 red(people에 role 없음·바 없음).
- 구현: 1d27f6c(공유 CollabPresence + PPT 셸) · 2f2e0f0(patch people·updateCollabIdentity)
  · 53e81ec(peers·ready 재게시, seeder 공백) · cffb58d(XLSX 바·follow·identity sync)
  · cc9443a(allowlist 경로). ooxml-ui dist/xlsx.js 5 hunk, 단일 복사본 기준
  ooxml-ui@1.8.0_patch_hash=oztj7diw66m2zwxeaqluw57q7y_three@0.186.1.
- green: presence.spec.ts 4 passed (chromium, 44.2s). 회귀 X2a-1·X2a-5 2 passed,
  PPT E1(desktop) 1 passed. 모바일 E11m 3건 실패는 베이스라인 기존 실패와 동일
  (gotoSlide 썸네일 타임아웃, presence와 무관).
- 게이트: frontend tsc 0, check:memory 오류 0/경고 1(D36), check:encoding 0(경고 1 기존).
- 결정: D49. C1 범위 이월 없음(v0.13 백로그 기존 항목은 유지). 남은 것은 태그 전 사용자 수동 체크 ①-⑤.

## C2 엑셀 자동 복구 + 자동 저장 (2026-10-29, release-0.12)

- 0절: nohash 배너는 `hashBytesHex(crypto.subtle)` 실패 경로(`DocumentPreview.tsx:1752`,
  `collab.ts:135`)가 맞다. 같은 응답의 ETag로 대체 가능(`useRawFile`이 바이트와 함께 보관,
  서버 ETag = sha256 hex, `Cache-Control: no-store`라 304 없음). PPT 폰 http는 편집 가능하나
  코멘트 `guid()`의 `crypto.randomUUID`가 터졌다 → `ooxmlGuid.ts`로 교체(선행 수정 dbc7ff3).
  `XlsxViewer.tsx`는 별도 파일이 아니라 `DocumentPreview.tsx` 안 컴포넌트다.
- C2-a: knownHash = 서버 ETag. `hashBytesHex`·`sha256Hex`·M1 dedup 삭제, nohash 분기 삭제,
  프론트 `crypto.subtle`·`randomUUID` 0곳. ETag 누락 → 재수신 1회 → 보기 전용 + "다시 연결".
  red: C2-a nohash 배너 + active false → green 4 passed (join·ETag 200·전파·stale 차단).
- C2-b: stale_client는 재수신 1회 후 재참가. stale_room + 빈 고아 방은 서버가 디스크 기준
  리셋 후 host로 만든다(`createSession` strict 분기, `everConnected` + rooms 동일성 가드).
  stale_room + 편집자 있음은 strict 없이 참가하고 외부 배너를 띄운다. 복구 불가면 보기 전용.
  "단독 편집으로 진행합니다" 문구 0곳(주석 제외). 타임아웃·서버 오류도 보기 전용 + 다시 연결.
  서버 응답 없는 경우(오프라인)에만 If-Match 잠금 유지로 단독 편집 허용.
  red: C2-b-1/2/3 → green. X0a-3(참가+외부 배너)·X0a-7(ETag 참가)·X0a-10(보기 전용+재연결)·
  X2a-3(참가+외부 배너)으로 개정. X0a-8은 solo 잠금 직접 검증(If-Match 409)으로 개정.
  앱→서버 절대경로 fetch는 CORS로 ETag가 가려지므로 e2e에서도 상대경로를 쓴다.
- C2-c: `reevaluateOwner`의 xlsx skip 해제(서버). `broadcastMeta`·`checkSave`는 xlsx를
  그대로 건너뛰어 와이어·저장 판정은 그대로다. owner만 2.5초 디번스로 자동 저장(keepEditing,
  성공 토스트 생략, 실패는 토스트+배너+내 사본). 폴링 없음(변경 이벤트 때만 예약).
  owner가 나가면 서버가 위임하고 다음 자동 저장이 따른다. red: POST 1건 → green.
  noSubtle 스텁이 getRandomValues를 0으로 막아 Yjs clientID가 전부 0이 되어 awareness가
  충돌했다 → 스텁을 subtle/randomUUID 제거 + 진짜 난수로 고쳤다.
- 회귀: xlsx-collab 전수 20 passed · xlsx-c2 + presence 11 passed · X-B1/X-B2 · M6a/b ·
  U1~U3 · PPT E2 5종 passed. backend 560 passed/0 failed(sqlite 2 스위트 기존).
  frontend tsc 0, check:memory 0/경고1, check:encoding 0, eslint 333(272/61).
- 기준선 대비 변동: `memoryRender.test.ts`가 C1 이동(NowProvider→CollabPresence)을 따라감.
  `memory-allowlist.json` 동일 사유 1행 경로 변경(cc9443a).
- 결정: D48 보완. v0.13 백로그에 서버측 편집 API/MCP 조사 1줄 추가.

## C3 접속자 표시 완성 — 팝오버·"(Me)"·따라가기·이미지 잠금 (2026-10-30, release-0.12)

- red: e2e/collab/c3.spec.ts P-5~P-9 + C3-img-1/2 + C3-flush/undo/release (500256d).
- P-6 이름 변경: PPT는 `saveCollabUser`+`session.setUser` 후 `setReloadKey` 리마운트라
  팝오버가 닫힌다 → 제출 시 명시적으로 닫고(`setOpen(false)`) 다시 열어 `(Me)`를 확인한다.
  XLSX는 `xlsxHandle`이 React 래퍼 ref(`O()`)라 `updateCollabIdentity`/`reveal`이 없어
  조용히 스킵됐다 → element(`xlsx-editor`, 패치된 메서드 보유)로 위임 보정한다
  (인라인 ref 콜백은 detach/attach 무한 루프를 일으키므로 effect에서 1회만 보정).
  seedUser는 `addInitScript`가 매 내비게이션 덮어써서 reload 유지 단언이 깨졌으므로
  키가 없을 때만 심는다.
- P-7 따라가기: (1) XLSX `reveal` 미동작의 진짜 원인은 위 핸들 문제였다(같은 수정으로 해결).
  (2) 연속 이동 유실: 500ms `followNavigatingRef` 창 안에 들어온 이동이 버려지므로
  목표로 중복을 가린다(`lastFollowNavRef`) + 리마운트 시 핸들 기준으로 재탐색한다.
  (3) PPT 자가 리마운트(2회/초 ref 재생성)가 slide-1 게시 300ms 타이머를 계속 취소했다 →
  게이트 disarm을 viewerKey 변경 때만 한다(ref 콜백 disarm 삭제). W1/E19b green 유지.
  (4) lib 자동따라가기(`useBroadcastFollower`, viewer가 owner를 추적)가 앱 unfollow를
  무력화했다(P-7b B가 3으로 끌려감) → `patches/pptx-react-viewer@4.33.0.patch`에
  `paused: true`(C3 주석)로 끈다. XLSX lib에는 해당 기능 없음 확인.
  (5) Esc가 팝오버→모달→편집종료까지 전파돼 B가 편집에서 나갔다(P-7d B 이탈) →
  window 캡처에서 선점 차단한다(입력칸 Esc은 제외). 바깥 클릭은 따라가기 해제다
  (`onDismiss`, P-7b). 썸네일 내비게이션(aside)은 따라가기를 유지한다 (P-7c 상호 팔로우).
- C3-img/flush/undo/release: 가드 throw는 설계(롤백·히스토리 미기록)대로라 테스트가
  받아낸다(`xlsxMoveImage`가 `{ok, error}` 반환). E2E에도 Toaster를 숨김 마운트하므로(App.tsx),
  가드 에러 문구·롤백 상태·토스트 1회로 단언한다. 저장 디스크 단언은 네임스페이스 접두사를 걷어낸 뒤
  바꿨다(lib 저장본은 `<xdr:row>`, 픽스처 원본은 `<row>`).
  C3-release는 모달 대신 reload로 나간다(데스크톱 모달 닫기 미지원 + `catch` 삼킴 방지).
- green: c3.spec.ts 16/16 chromium + 16/16 msedge. P-5/P-6/P-9 포함.
  회귀(격리 실행): presence 4/4 · xlsx-collab 20 · xlsx-c2 7 · ui-layout+viewer-unmount+
  xlsx-solo 7 · pptx E17/E19b · backend guard 단위 9 · frontend tsc 0 ·
  check:memory 0/경고1(D36) · check:encoding 0 · eslint 333(272/61, 기준선과 동일).
  (전수 337=276+61은 C3-line 회귀 4건이었음: CollabPresence react-refresh 3 +
  guard dist-path 테스트 regex 1. `5794f27`에서 수정 후 333으로 복귀).
- E8은 10-27 전수 기준선 실패 18건에 포함된 기존 실패다(위 트리아지 표 v0.13행).
  변경 없이(스태시) 돌려도 동일하게 실패하므로 C3 회귀는 아니다.
  전체 스위트 전수 대조 결과는 아래 P0-3 회귀표에 있다.
- 결정: D48·D49 보완으로 처리(D50 미생성). C3 범위 이월 없음(v0.13 백로그는 D49 등 기존 항목 유지). 남은 것은 태그 전 사용자 수동 체크.

## P0-3 회귀표 (2026-10-30, HEAD `6717e22`)

- 공통 명령(PowerShell 5.1): `$env:NODE_ENV='development'` 후
  `npx --yes pnpm@9.15.0 exec playwright test --config e2e/collab/playwright.config.ts <파일…> --project=chromium --reporter=line`
- c3.spec.ts 18 tests(P-5~P-9 + img/flush/undo/release + comment undo/redo): **18 passed**.
- 격리: presence 4 + xlsx-collab 20(X2a-1~7 포함) + xlsx-c2 7 + xlsx-solo 2(X-B1·X-B2) +
  viewer-unmount 2 + ui-layout 3 = **38 passed**.
- pptx-collab 전수(35 tests) run-2: **16 failed / 1 skipped(E2r-legacy, test.skip) / 18 passed**.
  실패 16건: E21b, E3, E4, E7, E8, E9, E12, E15, E18, E16b, E20, E20s, E21,
  E11m/E1m, E11m/E2m, E11m/E3m.
  10-27 기준선 18건과 대조: E5·E19b 2건 해소(이제 통과), **신규 실패 0건**.
  run-1(18 failed)과의 차이 2건: E1(아바타 이니셜 단언 stale → `6717e22`에서 E17과 같은
  팝오버 행 단언으로 수정, run-2 통과), E6(전수에서만 `lastSave` 미기록 실패 →
  run-2 + 단독 실행 통과, 부하 타이밍 플레이크).
- E2 5종(E2, E2b, E2f-strict, E2g, E2r): run-1·run-2 모두 통과. PptxViewer 게이트 변경 영향 없음.
  (`paused:true`는 lib broadcast 자동따라가기만 끈다. E 계열에서 follow UI를 쓰는 테스트는
  없고, e2e grep상 follow 사용은 c3.spec뿐이다.)
- X2a 7종: xlsx-collab 내 전부 통과. X-B1·X-B2: 통과. E21·E11m 3종: 기준선 실패와 동일.
- backend vitest: **570 tests passed**, 파일 60/62(실패 2종 `config-migration`·`repo-tracking`은
  `bun:sqlite` 기존 항목).
- frontend eslint 333(272/61, 기준선과 동일, P0-2) · frontend tsc 0.
- 판정 원문: E6 run-1 `expect(d.lastSave?.status).toBe(200) / Received: undefined`
  (pptx-collab.spec.ts:581). D26(E21b)은 run-1·run-2·단독 실행 모두 `toHaveCount(0)` 실패로
  기준선과 동일하므로, 이전 "순서 의존 플레이크"·"vite 캐시 탓" 판정은 철회한다.

## C4-2 1단계 완료 (2026-10-31, release-0.12)
- 범위: D50. image/chart/sp/smartArt 이동·삭제 허용 + 락, EMB는 C5.
- e2e c3.spec.ts C4 8종(mismatch/move/lock/delete/move-undo/delete-undo-blocked/late-join/leave-release):
  chromium 8/8, msedge 8/8. C3-img-1/undo/reconnect는 C4 의미로 재작성
  (차단→동기화·전파·오프라인차단+복귀수렴). c3.spec 전체 chromium·msedge 각 27/27.
- 단위: collab-objects 18 + xlsxCollabGuard 13 + xlsxObjects 10 = 41 passed.
- backend 전체: 62 파일 passed, 2 파일 실패는 bun:sqlite 기존 항목
  (config-migration·repo-tracking). frontend tsc 0, 변경 파일 eslint 0.
- 남은 한계(1단계): solo 구조변경 후 합류 시 키 재발급 발산,
  오프라인 중 로컬 변경의 재접속 재전송 없음(차단으로 fail-closed),
  삭제-409 복구는 스택 꼭대기가 Delete일 때만, 고아 키 잔류(무해).
- 다음: exe 0.12.74 빌드·PC2 수동확인·태그. EMB 정규화는 C5.
## C4-2 회귀 + X-B1 수정 (2026-10-31)
- X-B1 20회 Edit/Done에서 objects/o1·o2/delete 404 2건: 리마운트(새 모델·태그 소실) +
  방 재생성 후 재등록을 건너뛰어 유령 삭제 POST가 나갔다. 수정: epoch을 regKey에 포함
  (방 재생성 감지), 핸들 교체 시 재등록, 태그 없는 모델에서는 삭제 판정 보류.
- 회귀: xlsx-collab 20 + c2 7 + solo 2 = 29/29 chromium. pptx 전수 16 failed / 18 passed로
  기준선과 동일(신규 0). backend 62파일 + bun:sqlite 2 기존. frontend tsc 0.
- 다음: exe 0.12.74 빌드·PC2 수동확인·태그.

## C4-3 0절 (2026-10-31, 기준 release-0.12 = 612610d)
- F1 측정(e2e 2탭): join/이동/Done/재진입/40s 전 시점에서 lib people 항상 2명(본인+상대, userId 포함), 서버 participants userId 기준 2명, 앱 아바타 2개. 중복 재현 안 됨. WS는 탭당 1개씩 순차 재연결(동시 중복 소켓 없음). 단, 재연결 churn 큼(탭당 생애 6~7회 connect, 매번 새 yjs clientId).
- F1 결론: (가) 기각. (다) 확정 — 앱 presence 바가 lib people을 userId 묶음 없이 1:1 렌더. lib 타이틀바 패치와 서버는 이미 userId 기준 묶음. churn + 30s stale 창 + 서버 120s sweep 구간 과도 중복이 그대로 표시된다. 수정: 앱도 userId 기준 묶음(없으면 clientId).
- F2: lib 타이틀바 사용자 표시 = office-ui-presence.xve-title-people, people.hidden = !sharing.active. 설치본 dist에 숨김 없음 확인, 패치에도 hunk 없음(빠진 것). 1 hunk 추가 예정. PPT는 hiddenDialogs share 로 이미 숨김.
- F3: lib 공개 선택 이벤트는 selection-change CustomEvent 하나뿐(bubbles+composed). 개체 선택/해제 이벤트 없음 → 앱 pointerdown + selection-change + Escape + Done/언마운트 조합, 폴링 없음. 셀 잔상: updateCollabIdentity 확장(range/sheet passthrough, C1 패치 동일 함수 1 hunk) — resolveSelections가 sheet/range 없는 peer를 스킵하므로 원격 박스가 사라지고 다음 셀 변경 때 lib이 다시 게시. A측 필터 기각.
- F3 해제 트리거: 다른 셀 클릭, Escape, 다른 개체 선택(이전 락 먼저 해제), 삭제 완료, Done, 언마운트, WS 끊김(서버 removeConn→releaseObjectLocks 확인, 앱 조치 불필요). 현재 앱 unlock 호출 0곳 확인.
- F4: 오버레이 위치는 .xg-obj[data-index] DOM rect, key 연결은 기존 __ck 대응 재사용. quadrants별 중복 가능 → 보이는 노드마다 그림. 갱신은 scroll 캡처 + ResizeObserver + MutationObserver(rAF) + 표 변경/원격 적용 후, 폴링 없음. lib 원격 박스(.xg-remote, 테두리 2px + 이름표)와 같은 스타일, testid=xlsx-object-remote-sel + data-key.

## C4-3 구현 (2026-10-31, chromium 10/10)
- F1 (e021ec8): 앱 presence 바를 userId 기준 묶음 (`groupXlsxPeopleForView`, 없으면
  clientId). follow id도 묶음 id (`u:`/`c:`). F1-dup/F1-two pass.
- F2 (78327fa, patch+lockfile): lib 타이틀바 presence `people.hidden = true` 1 hunk.
  구 patch 파일은 hunk header가 깨져 있어 fresh install 불가 상태였음
  (`pnpm patch` integrity check 실패) → header 재계산 후에도 start 불일치로 실패 →
  patch 파일 걷어내고 pristine 추출 → 설치본(v1) 복사 → v2 적용 → `patch-commit`으로
  재생성. 이제 `pnpm patch` 검증 통과. pnpm-lock hash 갱신.
  주의: install은 반드시 `NODE_ENV=development` (production이면 devDeps skip되어
  vite/playwright/typescript 누락).
- F3 (b747941): 해제 트리거 = 다른 셀 클릭·Escape·다른 개체·삭제 완료·Done·언마운트.
  셀 잔상 = `updateCollabIdentity({sheet:null,range:null})` (C1 패치 함수 확장).
  근본원인 1: lib이 개체 pointerdown에도 클릭 전과 같은 선택으로 selection-change
  에코를 쏨 → 막 잡은 락을 즉시 풂 (POST→GET→DELETE race, F3-unlock flake).
  수정: pointerdown 때 `getSelection()` 스냅샷(`objGrabSelRef`)을 찍고 detail이
  같으면 에코로 무시, 다르면 해제.
- F3 잔상 심화: clear가 `session.on("peers")` 재게시로 즉시 되돌려짐
  (B 자신의 people이 D5로 복귀, A 박스 4개 유지). 수정: patch v2 `hideCell`
  (clear 당시 선택과 같은 publish는 skip, 다음 진짜 변경 때 resume+게시).
  F3-ghost/esc/unlock pass. F3-unlock의 D5 재선택이 resume 경로가 되어 박스 복귀도 pass.
- F4 (8c4218d): `.xg-obj[data-index]` rect → 오버레이
  (`data-testid=xlsx-object-remote-sel`, `data-key`, lib .xg-remote와 같은 2px+이름표).
  갱신 = scroll 캡처 + ResizeObserver + MutationObserver(rAF) + 표 변경·원격 적용 후.
  남 개체 드래그는 `decideObjectOp` foreign 가드 + 홀더 토스트 1회(dedupe).
  F4-follow는 테스트 레이스 수정 (8be63ec: y값 자체를 poll).
- 검증: c4-3 10/10 chromium (F1 2 + F2 1 + F3 3 + F4 4). tsc 0.
  eslint 동일 파일 5 errors+1 warning은 수정 전후 동일 베이스라인(신규 0).
  backend 62 pass + config-migration/repo-tracking 2 fail(기존, collab 무관).
  C4-move/move-undo 기존 green 유지.

## C4-4 측정 (2026-10-31, 기준 3778669, RepoDetail 패널+시트 실측)
- 방법: RepoDetail(`/repos/:id`)에서 Files 패널로 파일 열기(viewer 마운트 1) →
  패널 Maximize2로 FileBrowserSheet 열기 → 같은 파일 열기(마운트 2) → 시트 닫기.
  편집기 수·people(clientId/userId/role)·서버 participants·앱 아바타 기록.
- XLSX 미리보기만: editors 1, lib people [{cid, uid:u-ada, self, viewer}],
  서버 participants 1 (id:u-ada, view), 바 1개·아바타 1개.
- XLSX 패널+시트: editors 2, 각 people에 {self cid, other cid} 2명 (userId 동일 u-ada).
  서버 participants 1 (userId dedupe, D50 2-2 규칙). 바 2개·각 바 아바타 1개 (F1 묶음).
  WS는 lib 인스턴스당 1개라 2개 (아래 기본안 검토 참조).
- XLSX 시트 닫기: editors 1, participants 1, 유령 없음.
- PPT 미리보기만: viewers 1, 바 1개·아바타 1개, participants 1.
- PPT 패널+시트: viewers 2, collabSessionRegistry가 같은 savePath 세션을 공유하므로
  yjs clientId 1개 → 바 2개·각 바 아바타 1개, participants 1.
- PPT 시트 닫기: viewers 1, participants 1, 유령 없음.
- 가설 판정: (가) 마운트 2회는 사실(XLSX 2세션, PPT 1세션 공유).
  (나) 기각 — 양쪽 userId 동일(u-ada). (다) 해소됨 — XLSX F1 묶음 + PPT usePeers
  app.id 묶음 + 서버 userId dedupe로 표시 1명. 0.12.74에서 2명으로 보이던 것은
  F1 이전 XLSX 미묶음 표시가 원인 (F1은 0.12.75에 포함, 당시 원격 미반영).
- 서버 owner: conn 기준 첫 edit conn 1개 유지 (같은 사람 owner 2명 없음).

## C4-4 구현 (2026-10-31)
- G1: 코드 변경 없음 (표시·서버·owner 모두 이미 1명). 세션 공유 기본안은 검토 후
  보류 — 같은 Y.Doc를 두 에디터가 공유하면 peers 에코 재게시로 presence가
  A1/D5로 핑퐁한다 (C4-3 hideCell 분석과 같은 구조). lib 변경 없이는 막을 수 없고,
  5-hunk 예산 내 안전 구현이 불가. WS 2개 유지만 남으며, 기능상 무해함을 e2e로 잠금.
- G2: 앱 presence를 lib 타이틀바 actions 슬롯으로 이동 (lib 패치 없음).
  - XLSX/DOCX: useTitlebarSlot 훅 — shadow DOM의 office-ui-title-bar를 찾아
    `<div slot="actions" style="display:contents">`를 붙이고 createPortal로 렌더.
    MutationObserver로 타이틀바 재생성 추적 (폴링 없음).
  - PPT: 기존 titleBarSlot prop 사용 (편집 모드에만 타이틀바 존재).
    보기 모드에는 타이틀바가 없어 헤더 presence를 유지한다 (편집 시 타이틀바로
    이동하므로 화면에는 항상 한 곳만 보임).
  - 헤더 CollabPresenceShell 제거 (XLSX), DOCX는 빈 shell만 (참가자 0명 → 표시 없음).
- G2-rename: 타이틀바 팝오버에서 변경 → 상대 화면 반영 확인.
- 관할 커밋: test(c4-4) red 선행 (G2 5종 실패 원문 포함) · feat(c4-4) G2.

## C4-4 검증 (2026-10-31, 최종 트리)
- red 선행 (chromium): G1-panel-sheet 1건 flake 제외하고 G2 5종 실패 확인
  (inTitleSlot 0, header에만 presence). G1 4종은 초록(표시·서버·해제 이미 정상).
- green: c4-4 10/10 chromium + 10/10 msedge.
- 회귀(최종 트리): c3 27/27 양쪽, c4-3 10/10 양쪽, xlsx-solo/collab/presence/c2 +
  viewer-unmount + ui-layout 38/38 chromium (X-B1/X-B2, E2 5종 포함),
  pptx 전수 18 pass + 16 fail(기준선 목록과 동일: E21b,E3,E4,E7,E8,E9,E12,E15,
  E18,E16b,E20,E20s,E21,E11m/E1m,E11m/E2m,E11m/E3m, 신규 0),
  backend 62 pass + 2 기존(config-migration, repo-tracking),
  frontend tsc 0, eslint 333(272e+61w, 베이스라인 동일).
- clean clone: NODE_ENV=development pnpm install --frozen-lockfile 성공.
  표식: ui "M21"(pptx chunk) · uiXlsx "X2a-ui"/uiXlsxPresence · X2a-core-esm ·
  coreXlsx "C3-guard" · hideCell/hasClear/people.hidden · viewer M21-cjs +
  viewerBroadcastFollow off. `pnpm patch ooxml-ui@1.8.0` 적용 검증 통과.
- exe 0.12.76 빌드 완료 (release/opencode-webui.exe). v0.12.76 태그 보류(수동확인 후).

## C4-5 같은 userId 원격 셀 숨김 (2026-11-01)
- 현상: 미리보기+큰 화면(같은 탭, 같은 userId, 다른 yjs clientId)에서 각 화면이
  상대 화면의 셀 선택을 원격 박스로 그려 "내 커서가 2개"로 보인다.
  측정: panel(viewer, A1)+sheet(editor, D5) → panel에 sheet D5 박스 4개(quadrants),
  sheet에 panel A1 박스 4개, 서버 participants는 userId dedupe로 1명.
- 수정: XlsxViewer가 lib `.xg-remote` 중 userId가 자신과 같고 self가 아닌 것은
  `display:none`으로 숨긴다 (노드 삭제 아님, lib 렌더와 무충돌, 해제 시 원복).
  트리거 = presence 변경 effect + shadow DOM MutationObserver (폴링 없음).
  남의 셀은 그대로 보인다. PPT/DOCX는 범위 밖.
- red: c4-5 G1-cell-dup (Expected 0, Received 4) → fix 후 green.
- 회귀: c3/c4/c4-3/c4-4 chromium+msedge 전부 green (C3-flush·P-5a·C4-mismatch flake는
  단독 재실행 green), xlsx 계열 38/38, pptx 기준선 동일(16 fail 목록 일치),
  backend 62+2 기존, tsc 0, eslint 333(272e+61w).

## C4-6 0절: 증상1=fileFullscreenRequest 팬아웃, 같은 파일 2에디터 (2026-11-01)
- 기준 470d53f. panel(viewer)+sheet(viewer) 동시 마운트 → 에디터 2개·세션 2개.
  viewer `el.select('D5')`는 빈 방에서 미게시, 시드된 방 viewer는 게시하므로 H3 필요.
- Edit은 `fileFullscreenRequest` 전역 이벤트라 전 FilePreview가 반응 → 증상1.
  612610d(0.12.74)에도 같은 코드라 신규 회귀 아님 (bisect).
- panel 닫기 → WS close+room 제거+40s 유령 0 (정상). selection은 양방향 공유
  (RepoDetail explorerSelectedPath): 시트에서 다른 파일 열면 패널도 따라온다.
  "패널=a+시트=b"는 수백 ms 안에 붕괴하므로 테스트 전제로 쓸 수 없다 (H1-fanout 참조).

## C4-6 구현 (2026-11-01, H1→revert→H2→H3)
- H1 (1e91e11): fileFullscreenRequest/Change에 path 동봉, 받는 쪽 path 불일치 무시.
  F4-follow 정리와 무관. FilePreview effect deps에 file.path 추가 (f8043fa, eslint 333 유지).
- revert (fd8615b): C4-5 `0e7021b` 되돌리기 (H2 단일 에디터로 대체, c4-5.spec 삭제).
- H2 (e03cf67): 탭당 같은 파일은 FilePreview 하나만 마운트.
  `openFileRegistry.ts` (surface panel/sheet 등록, editing 절대 양보, computed shadow).
  FilePreview에 `surface` prop + `useShadowedFile` + `preview-shadowed` placeholder
  (office만, 헤더 포함 통째 교체). FileBrowser `previewSurface` prop
  (SessionFilePanel=panel 명시, FileBrowserSheet=sheet 명시, embedded와 무관 —
  SessionFilePanel도 embedded라 기본값 유추는 버림). MobileFilePreviewModal=sheet 고정.
  FilePreviewDialog(diff)는 기본값 panel 유지 (회귀 없음, 개선도 없음).
- H3 (57ae135): lib 패치 1 hunk — viewer는 selection 미게시
  (`if (session.role==="viewer") return;`), pnpm patch→patch-commit→install,
  hash xepimnkaf52ojk5qmfv45l4m7q. 에디터 박스는 viewer에 그대로 보인다.
- H1-fanout 전제 수정 (e07b136): selection 공유상 패널은 시트를 따라가므로
  "시트 Edit → Edit한 쪽만 전체화면"으로 재구성 (assert는 그대로).
- c4-4 G1 재작성 (3e1a387): "2마운트" 전제를 H2 단일 마운트로 교체
  (placeholder+아바타1+참가자1+닫으면 복귀). openInSheet 헬퍼 H2 인식 (c4-4/c4-6 공통).
- 관할: test(c4-6) red → H1 → revert → H2 → H3 → test-only 2건 → docs.

## C4-6 검증 (2026-11-01, 최종 트리 f8043fa+3e1a387)
- c4-6 16/16 chromium+msedge (JSON).
- c4-4 19/20 + G1-sheet-close-unlock 단독 green (부하 flake).
- c3 54개 중 C4-mismatch 2 (단독 양쪽 green, 기존 flake).
  c4-3 20/20. xlsx 6종 76/76. pptx 양쪽 기준선 정확 일치(18+16+skip1).
  backend 62+2 기존(bun:sqlite 환경). tsc 0, eslint 333, memory 0에러,
  encoding clean.
- 주의: 14:55~15:10경 머신 부하로 백엔드 불안정 (Reconnecting, room GET 404,
  C2-b-3·X-B1 연쇄 실패). 동 코드로 전후 재실행 green — 환경 flake로 판정,
  코드 회귀 아님. 근거: 실패 지점이 FilePreview 미마운트 경로(workspace 행 목록),
  H2/H3 활성 조건(2 surface·viewer 게시)과 무관.
- exe 0.12.77 빌드 예정. v0.12.77 태그 보류(수동확인 후).

## C5-1 기존 OLE 첨부 보기·저장 (2026-11-01)
- 범위: 기존 첨부 보기+다운로드(신규 삽입은 C5-2). 3종(xlsx/pptx/docx)x2종(pdf/CFBoleObject, docx/package).
- O4 `frontend/src/lib/oleExtract.ts`: CFB 리더+Ole10Native 파서+살균+상한 (874f8d2, 단위 7종).
- lib 노출 (41d7880, chore): core xlsx `parseDrawing` AlternateContent unwrap+`oleShapeId`,
  core docx `w:object`→run.object+`createRun` 유지, ui docx.js `ole` atom+`data-docx-ole`,
  표식 `uiXlsxOle`/`uiDocxOle`="C5-1".
- lib 저장 수정 (f715c41, fix): `runIsSafe`가 단일 `w:object` 런 허용,
  `appendInlineNode` 병합 가드에 `!previous.object`(뒤 텍스트가 ole 런에 합쳐져
  유실되던 버그). docx/load 5 hunk, docx/ui 3 hunk.
- 앱 오버레이 (8643142, feat): `OleAttachmentOverlay.tsx`+`oleAttachments.ts`.
  embeddings/ 스캔 → 아이콘 1개 + dblclick 다운로드(CFB면 Ole10Native 풀기).
  XLSX 이동·삭제 가드 토스트 1회, PPTX lib compat 토스트 파일당 1회 정리.
- spec 보정 (3dba991, test): 시트 잔류 정리, DOCX proven 패턴, XLSX 명시 Save+커밋 재시도,
  seg 스코프 탐색(동명 파일 레포 간 혼선 수정).
- 검증: c5-1 4/4 chromium + 4/4 msedge. 회귀 xlsx-solo 2/2(X-B1/X-B2),
  backend 608 pass + 2 파일 fail(bun:sqlite 환경, 기존), tsc 0,
  eslint 신규파일 0, memory/encoding clean.
- 관문 G(사용자 PC): xlsx(docx첨부 2종)+pptx(docx첨부)+docx(xlsx첨부), 제네릭 PNG,
  영문 progId, Excel/PPT/Word 열기·더블클릭·재저장 — 미착수.

## S1 solo ole 자동저장 수정 (2026-11-01)
- 증상: 혼자 편집에서 ole 도형 이동이 저장 안됨 (같이 있을 땐 됨).
- 원인 2개: (1) 신원 미발급 브라우저는 rooms() self-match 실패로 scheduleAutosave가 조용히 skip (owner 선출됐는데도 some(owner)=true라 전원 skip). (2) 저장돼도 lib saveBytes가 unsupported drawing을 원본 그대로 보존해서 앵커 이동이 디스크에 안 남음.
- 수정: ensureCollabIdentity() (PPTX 세션과 같은 자동 발급, 표시명 user 유지) + 참가자 1명이면 self로 보는 solo fail-open (autosave 타이머, peer-arrive flush) + 저장 직전 flushObjectsNow() 후 서버 표 앵커를 drawing XML에 수술 패치 (frontend/src/lib/xlsxAnchorPatch.ts, twoCellAnchor from/to만 교체, vmlDrawing rel 우선 매칭 회피, 개수 불일치 시 fail-closed).
- 검증: e2e/collab/xlsx-ole-solo.spec.ts S1(드래그 후 move 이후 save에서 앵커 이동+oleObject 보존) S2(신원 자동발급). 단위 5/5. 회귀 c5-1 4/4 + xlsx-solo 2/2 + xlsx-collab 20/20 (chromium), tsc 0, eslint 신규 0, memory/encoding clean.

## S2 ole anchor (2026-11-01)
- ole-icon 분리 버튼 문제를 lib 도형 위 앵커로 해결: OleAttachmentOverlay가 anchor prop으로 도형 rect에 아이콘 1개를 둔다. hover 파일명, dblclick 다운로드 유지. 앵커 없으면 좌상단 칩 폴백.
- shadow DOM 추적 domDeep.ts (deepCollect/observeDeep). xlsx 도형은 shadow 아래라 컨테이너 MO만으로 못 보고 shadowRoot까지 관찰한다. PPTX compat 토스트 sweep도 deep query로 수정.
- XLSX 읽기전용 가드 제거: S1 방향에 따라 아이콘 드래그/삭제는 무시 (토스트 없음). c5-1 가드 테스트를 S2b로 교체. EMB는 서버 emb_locked 유지.
- 검증: c5-1 5/5. tsc 0, eslint 신규 0, memory/encoding clean.

## C5-2 INSERT 문서 첨부 P2-1 (pptx, 2026-11-01)
- POST /api/collab/embed (multipart path/file/slide?/roomId?/clientId?/baseHash?): 첨부 docx/xlsx/pptx + 매직바이트 + 20MB, viewer는 편집자 있을 때만 403, dirty면 409 dirty_room (owner 저장 후 1회 재시도).
- 서버 조립 backend/src/services/office-embed.ts: pptx/embeddings + 미리보기 PNG(제네릭 아이콘) + slide rels 2개 + graphicFrame + VML(있을 때) + Content_Types. progId 영문 네이티브, pptx 첨부는 package rel.
- 조립 후 디스크 기록 + 방 있으면 resetRoomByServer (4001 dispose). 클라이언트는 4001 후 새 바이트를 먼저 받고 재입장한다 (stale 호스팅 방지: PptxViewer resetPending + officeResetReload).
- UI: 헤더 문서 첨부 버튼 + 숨은 input, officeEmbedFile 이벤트로 뷰어가 자기 컨텍스트로 POST. 단위 7/7, e2e P2-1 (pptx+docx 아이콘 2개+다운로드 원본 일치).

## C5-2 XLSX+DOCX (2026-11-01)
- assembleXlsxEmbed: drawing/oleObjects/VML 3곳 일치, 앵커는 사용 영역 아래 빈 행, progId 영문, 없으면 drawing/VML 파트 생성. assembleDocxEmbed: 문서 끝 새 문단에 w:object+VML, progId 영문.
- route에 xlsx/docx 호스트 연결 + sheet 파라미터, pptx와 같은 dirty/viewer/리셋 경로.
- e2e P2-2 (xlsx+docx, 3곳 일치 확인) + P2-3 (docx+xlsx, ProgID 영문 확인) green. 단위 12/12.

## E7 실패 확인 (2026-11-01)
- pptx-collab E7이 3회 연속 실패(mountCount 6 vs 7). d2434b9 worktree에서 동일하게 실패하므로 내 변경과 무관한 기존/환경 문제로 판정. E2는 green.
- backend 전체: 625 pass + 2 fail (bun:sqlite 환경, 기존과 동일 - config-migration, repo-tracking).

## 본문 미리보기 수정 (2026-11-01)
- 증상: 첨부는 되는데 본문에 미리보기 그림이 안 보임. 원인 2개: (1) PPTX graphicFrame xfrm 접두어 오류(p:가 맞는데 a:로 씀) +اصمة?아님+ lib가 xfrm을 못 읽어 0x0 렌더. (2) XLSX ole를 sp로 넣어서 lib가 unsupported 박스만 그림.
- 수정: p:xfrm로 고침 + assembleXlsxEmbed를 pic 앵커로 변경 (cNvPr name=ole명, blip PNG, drawing rels). pic은 네이티브라 렌더+이동+저장이 그대로 된다.
- 오버레이도 pic에 앵커되게 변경 (img alt 매칭, 없으면 구형 sp 박스로 폴백). checkBalancedXml로 조립 XML 검증 (깨진 바이트 기록 방지).
- 검증: 단위 13/13, P2-1 본문 프레임 표시 assert + P2-2 본문 IMG assert green, c5-1 5/5 + S1/S2 green.

## 본문 미리보기 검증 강화 (2026-11-01)
- P2-1에 프레임 표시+PNG img assert, P2-2에 본문 IMG alt assert 추가. 셋 다 green.

## pic 이동 저장 검증 (2026-11-01)
- P2-2에 pic 드래그 후 디스크 앵커 이동 assert 추가 (네이티브 저장). green.

## C5-2 첨부 탭 (리본 add-in, 2026-11-01)
- lib가 built-in 탭(Insert 등) 교체를 금지하므로(acceptedRibbonAddIns) 공식 ribbonAddIns로 Help 뒤에 "첨부" 탭을 둔다 (Office ACROBAT 탭 방식). lib 패치 없음.
- officeEmbed.ts: buildOfficeAttachAddIn + requestEmbedFile(officeEmbedRequest). 숨은 input 상시 마운트, DocumentPreview가 요청을 받아 클릭 → 기존 officeEmbedFile 흐름 재사용.
- 편집 모드 진입점=리본 탭, 보기 모드(리본 없음)=헤더 버튼 유지. 헤더 조건 실수로 Done/Save까지 숨긴 회귀 → 버튼에만 !editing 적용해 복구.
- e2e P2-4/5/6 (pptx/xlsx/docx 탭 경유) green. c5-2 6/6, c5-1 5/5, 단위 14/14, tsc 0.

## xlsx append xdr 네임스페이스 수정 (2026-11-01)
- 증상: 편집 모드에서 첨부 후 "Invalid XLSX worksheet XML ... NamespaceError". 편집 저장본(lib 저장본, oleObjects xmlns:x14 형태)에 덧붙일 때 서버 템플릿의 xdr: 접두사가 미선언.
- 수정: oleObject 엘리먼트 자체에 xmlns:xdr 선언 (자립형). 단위 테스트(append 경로) 추가 — 수정 전 red 확인.

## C5-2 리뷰 보완 (2026-11-02)
- P2-4/5/6 red 원문 없음 (feat 4f8800c가 test fbbd0d6보다 먼저 커밋됨 — 순서 준수 실패).
- 대신 feat 되돌림(af10b78 상태 3종 파일) red 원문 확보 — 3종 모두 동일 지점 실패:
  `TimeoutError: locator.waitFor: Timeout 30000ms exceeded. - waiting for getByRole('tab', { name: '첨부', exact: true }).first() to be visible`
- 판단1: Insert 탭 그룹 추가 불가. xlsx/docx 렌더러는 기존 패널 불변 + 새 패널만 append, pptx도 별도 탭 버튼 렌더. 탭 방식 유지 (D60 추기).
- 보완2: 보기 모드 헤더 "문서 첨부" 버튼 삭제 (편집 행위로 통일, solo는 Edit 후 첨부). P2-1/2/3도 탭 경로로 전환.
- 실물 progId 참고: 한글 Office 원본은 progId="포함된 개체"/"Package" (C5-0 영문 팩트는 서버 신규 조립분에 해당).

## C5-2 회귀 행렬 (2026-11-02)
- msedge: c5-2 6/6, c5-1 5/5. chromium: c3/c4-3/c4-4/c4-6/ui-layout 58 passed, E2 5종(E2·E2b·E2f-strict·E2g·E2r) green.
- xlsx 묶음 29 passed + 2 flake (X-B1 404 /objects, X0a-9 — 단독 재실행 green, 인과 경로 없음).
- pptx 전수: 17 failed / 17 passed / 1 skipped. v0.12.70 기준과 차이나는 2건 worktree(6150122) 대조: E13은 기준에서도 실패(기존), E19b는 기준·HEAD 모두 통과.
- eslint 333 (272E+61W, 신규 0 — 전수 기존 이슈), check-memory 0E+1W, check-encoding 이상 없음(경고 2 기존).
- keepEditing 수정: 임베드용 선저장은 편집 유지 (수동 Save 종료 유지). P2-1 프레임 stale 해소.
- 0.12.79 exe+zip 빌드 완료. 실기 파일: C:/Users/oh/AppData/Local/Temp/opencode/c52-real/ (형식별 1개, 편집 모드 첨부).

## xlsx 보기 모드 리본 표시 + unsupported ole 카드 (2026-11-02)
- 증상 2건: (1) 보기 모드에서 리본 자체가 없어 Insert 탭이 안 보임 (`showToolbar={editing}` 때문). (2) 기존 ole(sp 앵커, lib 미렌더)가 "shape (not shown)" 자리 표시자로만 보임.
- 수정1: XlsxViewer `showToolbar` 상시 true. readOnly라 lib가 편집 커맨드 비활성화 확인 (Insert 패널 Table/Pictures/Link/Comment/Symbol 전부 disabled). 보기 모드 첨부 탭은 숨김 유지 (첨부는 편집 행위 — 보완2).
- 수정2: OleAttachmentOverlay가 placeholder(`xg-obj-unsupported` + "shape (not shown)" 텍스트) 위치에 미리보기 카드(불투명, 파일형식 아이콘 + CFB Ole10Native에서 꺼낸 실제 파일명, 예: oleObject1.bin → payload.pdf)를 덮는다. 카드는 표시 전용(pointer-events-none) + 모서리 기존 아이콘으로 dblclick 다운로드 (S1 드래그 회귀 1건 잡고 수정 — 카드가 mouse 이벤트를 삼켜 shape 이동이 안 됐음).
- 검증: c5-2 6/6, c5-1 + xlsx-ole-solo (S1/S2) green, ui-layout 8 passed, tsc 0, eslint 신규 0.

## C5-3 첨부 편집 (2026-11-03)
- 구현: AttachmentEditor 신규 (package 파트 GET/PUT, path+part 잠금 TTL60, 읽기전용 분기, dirty 무관 항상 PUT, saver 미준비 toast, 409 dirty_room/stale/locked/no_lock/view_only 구분, 20초 하트비트+D63+allowlist).
  FilePreview ATTACHMENT_OPEN_EVENT 오버레이 마운트 (손상 블록 원복). OleAttachmentOverlay dblclick 라우팅 (edit/previewPDF/downloadCFB).
  DocumentPreview standalone guard (방 미참가·첨부탭 숨김·PUT 우회). PptxViewer 리터럴 \r\n 개행 원복.
- 서버 (debaa62e): GET/PUT /api/collab/embed + POST/DELETE /embed/lock, PUT 성공 시 방 리셋(4001).
- E2 디버깅 4건: (1) expect.poll은 값 반환 안함 → zip 2단계 unzip+word/document.xml stamp poll로 전환. (2) xlsx 수식바는 input이 아니라 textarea. (3) docx lib은 shadow DOM 렌더라 document.activeElement는 호스트를 가리킴 → shadowRoot.activeElement 기준 focusAttachEditor 헬퍼 + 중앙 아이콘 회피 (120,60) 클릭. (4) VITE_E2E=1에서 Toaster display:none → 저장 토스트는 toBeAttached로 단언.
- 검증: c5-3 14/14 chromium, backend embed-attachment 15/15, tsc 0, eslint 신규 0 (기존 6E+11W), check-memory 0E+1W (D36 기존), check-encoding 이상 없음 (경고 1 기존).
  backend 전체 645 pass + 2파일 실패 (config-migration/repo-tracking, bun:sqlite를 node vitest에서 못 읽는 기존 환경 이슈).

## C5-3 회귀·판단 추기 (2026-11-03)
- package dblclick → 편집기 통일 (D63 판단1). C5-1:133·C5-2 P2-1/P2-3 다운로드 단언을
  에디터+바이트보존 단언으로 교체 (신 스펙 우선, 구 UX 폐기). oleObject/CFB 다운로드는 그대로.
- 선저장 실패해도 방 미시드면 POST 진행 (D63 판단2). 미시드=플러시할 내용 없음이 보장되므로 안전.
  계기: P2-4가 편집 없이 첨부하면 선저장 실패로 중단돼 풀런에서만 실패 → 90초 폴+재시도로 green.
- FilePreview AttachmentEditor 정적 import가 PPT 보기 join을 멈춤 (D63 판단3, c3 P-9a 계열).
  bisec으로 FilePreview 확정 → lazy 로딩 전환 후 26초대 복귀. E2unsaved·pptx-edit로 에디터 동작 확인.
- 회귀: c3/c5-1/c5-2 38 passed, c4-3/4/6 28 passed, xlsx-collab 19+1flake(X2a-6, debaa62e에서도 실패하는 기존 이슈),
  pptx-collab 18 passed +1 skipped, ui-layout·unmount·presence·solo·ole-solo·c2 19+1flake(P-1, 단독 통과),
  msedge c5-3 14/14·c5-1 5/5·c5-2 5/6(P2-1 풀런 flake, 단독 통과). X2a-6·P-1·P2-1은 부하 flake로 기록.

## C5-4 URL 편집 분리 (2026-11-03, D64)
- 방향: 편집 모드별 개별 URL (/edit/<경로>, /edit/<부모>/-/<파트>), 새 탭 window.open. 락 대신 partHash 낙관적 잠금(파트 해시 비교), 부모 flush는 서버 WS 요청으로 전환.
- 0절: 원격 상단은 7570a926 (e783efe는 조상, stale 보고 정정). 양 브랜치 7fa2b711 동기화. exe는 bun compile 서버+내장 에셋, 웹뷰 없음 -> window.open 정상.
- C5-3 오버레이 미커밋 4파일 revert, b5a11ca2/94437f7c는 history 유지. U-* 테스트로 대체.
- 멈춤 조건: 부모 flush에 lib 패치 필요 / U-parent 유실 / exe 새 창 불가. 출시 0.12.81, 태그 보류.


## C5-4 구현 1단계 (2026-11-03)
- 구현: editUrls 빌드/파싱, EditPage(크롬리스+DocumentPreview initialEditing/AttachmentEditor 재사용), App /edit/* 라우트+크롬 숨김, 미리보기 Edit->window.open, 첨부 dblclick->window.open, DocumentPreview 마운트 리셋 가드+StrictMode close 디바운스(1.5s).
- U-open 3/3 chromium green (host/part-xlsx/part-pptx). tsc 0, eslint 신규 0.
- flag-day 부채 (Edit 버튼 팝업 전환으로 구 흐름 red, 다음 단계에서 스위트별 마이그레이션): c5-1(2곳)·c5-2(attachViaAddInTab)·c5-3(E2 dblclick)·c3/c4-3/c4-4/c4-6/xlsx-collab/xlsx-solo/xlsx-c2/presence 직접 Edit 클릭. 증거: c5-2 P2-1 첨부 탭 대기 타임아웃 (in-page 탭 미생성, 팝업으로 이동됨).
- 관측: StrictMode remount cleanup이 onEditingChange(false)를 쏴 에디터 탭이 자살 -> EditPage 전이+디바운스로 방어. xlsx INSERT는 oleObject라 다운로드 유지 (package만 편집탭).


## 0e7abb4a spec 변경 기록 (P0-5, 2026-11-03)
- 원래: attachViaAddInTab이 in-page Edit 후 in-page 첨부 탭을 조작하고 ole 아이콘 dblclick을 page에서 했다. xlsx 파트는 zip 직접 수정(수동 package)으로 열었다.
- 변경: (1) openViaWorkspace에 폴더 진입 루프 추가 (c5-2와 동일, seg 행 탐색). (2) attachViaAddInTab이 Edit 팝업(에디터 탭)을 받아 반환하고 이후 단계(첨부 탭·filechooser·ole 아이콘·dblclick)를 editor에서 수행. (3) U-open-part-xlsx를 실제 INSERT 경로로 전환 (P0-4에서 zip 수술 제거).
- 이유: Edit 버튼이 /edit/* 새 탭을 열게 되면서 in-page 첨부 탭이 사라졌고, xlsx INSERT는 oleObject라 다운로드라서 수동 package로 우회했었다. P0-4 package 조립 후 실제 경로가 편집탭으로 열리므로 우회가 불필요해졌다.

## E2 디스크 반영 수정 (2026-11-04)
- 수정 (1) patches/pptx-react-viewer@4.33.0.patch M30/M31/M32 (+pnpm-lock hash).
  M30: handleInlineEditCommit 뒤 [...prev]로 참조 교체→publish 발화. M31: Escape도 커밋.
  M32: reader stale(도형 이름·원본·빈)시 DOM 텍스트로 대체(E7 오프라인 지움 방지).
  (2) PptxViewer 백스톱: 8s 시간게이트→latestSavedRef 바이트 비교(duplicate-content 스킵).
- 검증: E2/E2f-strict/E2r/E2c/E2f/E2g/E2b/E7 green(chromium), c5-4 7/7·presence 4/4 green.
  tsc 0. eslint PptxViewer 신규 0(1039 no-unsafe-finally 기존).
- 다음: U-close(참여자0/WS0 10회)→U-stale→U-parent. exe 0.12.81 빌드 미완.

## E2 bisect + U-close/U-stale (2026-11-04, 리뷰 대응)

### E2 bisect 결과 (7570a926..0a6fa9c4)
- 첫 적색 커밋: 0e7abb4a "feat(c5-4): /edit/* routes + EditPage + window.open entries".
  근거: 베이스(7570a926)에서 in-page E2 메커니즘 green 확인(디스크 반영 포함,
  3s reflect 예산만 38ms 초과 — 환경 flake). 0e7abb4a에서 Edit 버튼이 새 탭으로
  바뀌어 in-page 진입이 깨짐을 probe로 확인 (A가 viewer로 남고 에디터 미오픈).
  이후 flag-day(b1f35459~)가 진입을 openEditor(/edit)로 이관했으나, /edit에는
  unmount-remount가 없어 stale slides → write-back 미발화 → 디스크 미반영이 드러남.
- "14/14", "30/30" 카운트는 재현 환경에서 대응되는 정수를 찾지 못함
  (해당 시점 E-시리즈 테스트 수는 34개). 메커니즘 bisect로 갈음.
- 결론: 트리거는 앱 변경(D64 새탭+리마운트 제거)이 맞으나, lib 결함 3종은 실재한다:
  (1) Escape=취소로 collab 타이핑 유실 (solo는 refs 경유로 저장되므로 collab 전용 버그),
  (2) in-place 커밋이 publish를 깨우지 않음, (3) stale-read 커밋이 Y.Doc을 지움(E7).
  앱 리마운트로는 (3)을 못 고친다(blur-커밋도 같은 경로). lib 패치 유지가 정당하다.

### U-close (완료)
- U-close-1: 마지막 퇴장 뒤 방 참가자 0명 확인 x10 반복 (rooms API 폴링).
- U-close-2: 떠난 참가자의 피어 행이 B 화면에서 사라짐 (유령 없음).
- U-close-3: 저장 안 된 /edit 탭 닫기 시 beforeunload 확인 (PptxViewer unsavedLocalEditRef).
  red 확인: 가드 제거 시 테스트 실패, 복원 시 통과.
- AttachmentEditor에도 동일 가드 추가 (saverRef.isDirty).

### U-stale (완료)
- 서버 PUT에 partHash 낙관적 잠금 추가: 현재 파트와 다르면 409 stale_part.
  기존 baseHash/dirty_room 검사는 그대로 (방 수준), partHash는 파트 수준.
- 클라이언트: doPut에 origPartHash 전송, stale_part를 stale과 동일 처리
  (refetch → same-check → 1회 재시도 또는 reload+notice).
- dirty_room 경로에도 same-check 추가 (무조건 재시도 금지).
- /edit URL에 ?partHash= 버전 태그 (열기·저장 시 갱신, 딥링크 불일치 시 notice).
- 테스트: U-stale-1 (외부 변경→stale_part→덮어쓰기 없이 새로고침),
  U-stale-2 (?partHash= 불일치→경고+최신 로드).
- 서버 E2E 확인: unit test 6종 (frontend/test/collabBackstop.test.ts) +
  E2 no-false-positive 단언 (backstop.aba 미발화).

### ABA (backstop ETag) — 설계 기록
- 구현: decideBackstopSave (순수함수, frontend/src/lib/collabBackstop.ts).
  mineHash != serverHash 이면 스냅샷을 버리고 무조건 저장.
- E2E 재현 불가 사유 (기록용): ABA는 "내 snap==디스크 바이트인데 서버 해시가 바뀜"에서만
  발화하는데, 도달하려면 소유권 이전+재접속이 필요하고 lib write-back이 항상 먼저
  저장해 스냅샷을 갱신해 버린다. 대신 (1) 단위 테스트 6종, (2) E2 no-aba 단언으로 커버.
- 후속(별도): 오프라인→재접속 시 owner null 고착 (서버 election liveness).
  E2k 시도 중 발견: A 재접속+synced 상태에서도 ownerClientId가 null으로 남음.
  재현 조건 — A 오프라인(2분+ dead-conn sweep) 중 B가 owner로 저장 후 B 종료,
  A 복귀. 영향: 해당 방에서 아무도 저장 못함. C5-range 밖이라 이번에 안 건드림.

### lib 패치 재생성 (pnpm patch-commit)
- node_modules/.pnpm_patches 수작업본 폐기 → pnpm patch 로 새 디렉토리,
  M30/M31/M32 + viewerCommit 마커 재적용(영문 코멘트), pnpm patch-commit으로 재생성.
  파일당 단일 diff 블록, hunk 파일당 5개 (M30 3 + M31 1 + M32 1; 마커는 기존 hunk 내 변경).
  --frozen-lockfile clean-worktree 설치 검증 + marker 원문 확인 완료.
- 59커밋 대조(bcd54704..0a6fa9c4): P0-1 7edfa41e(BOM), P0-2+P0-3 95197834(onDone+opener),
  P0-4 888dbd9f(package), P0-5 2f7864cf(handoff), P0-6 1794fb9f(Pollers),
  커밋 규칙=1수정1커밋 red→fix 쌍 (c5-1/c5-2/c5-3/c5-4/xlsx/c3/c4-3/c4-4/c4-6 flag-day 일괄).
  pre-existing 실패 14종: E21b/E3/E8/E9/E12/E18/E16b/E21/E1m/E2m/E3m/U3/U2/X2a-6
  (pristine 1b74ea35 동일 실패 확인 — U2/U3는 이번에 새 동작 기준으로 재작성해 green).

## U-parent (2026-11-04, D66)
- 구현: 서버 WS flush 103/104 (`collab-rooms.ts` requestParentFlush + `collab.ts` PUT 연결).
  방에 편집자가 있으면 owner에게 flush 요청(8초), `preFlushHash` 수렴(flush 저장이 움직인
  해시는 받아들임 — 사이 부모 저장은 flush에 포함). 편집 conn 비정상 종료 기록이 있으면 409.
- 클라: ycollab own·transport 103 처리 + ack, xlsx 탭 transport 103 처리 + ack,
  officeSaveRequest는 `{keepEditing:true}` (없으면 바깥이 편집 종료). 4001 사유별 토스트
  (embed_reset은 바깥이 "첨부가 갱신되어 다시 불러왔습니다" 1회, PptxViewer 중복 억제).
- 테스트 4종 (c5-4): U-parent red 확인(수정 전 PUT 200으로 '부모 파일' 토스트 실패) →
  구현 후 green. U-parent-autosave/U-http/U-deeplink lock-in green.
- 디버그 기록: (1) pptx own 모드 직행 분기에 103이 없어 버려짐 → `100 || 103` 수정.
  (2) 재입장 자동 저장에 기대지 말 것 — 복구는 attach 재저장의 flush가 강제한다.
  (3) 오프라인 30초(room TTL) 초과 시 재입장이 디스크 기준이 될 수 있음 — 테스트는 안에 복구.
- 회귀: c5-4 16/16 · pptx-collab 26+1skip · xlsx-collab 19(+X2a-6 기존) · c5-3+c5-2 22 ·
  c5-1+presence 9 · c4-6+ui-layout+viewer-unmount+xlsx-c2+xlsx-ole-solo+xlsx-solo 23
  (+C2-b-1 flake, 단독 green) · c3+c4-3+c4-4 47 · backend unit 62 · frontend unit 20.


## C5-4c (2026-11-05, D67: U-parent supplement B1/B2/B3/B4 + C owner election liveness)
- 구현: 103/104 requestId 짝짓기(리스너를 dispatch보다 먼저 등록 — 동기 즉시-ok가 증발하므로).
  B2 clean-ack + 서버 docDirty 재확인 + xlsx dirtyRef 실측정(onWorkbookChange true/room 저장 false).
  B3 docDirty(시딩 10초 제외)+lastRemoteUpdateAt/lastSaveAt 조건부 settle, clean close 1000/1001
  drop 기록 삭제 + pagehide close(1000). C needsElection/reevaluateOwner(ownerIds 보수, addConn은
  hasKnownMode 게이트). B4 resume 배너+내 사본 다운로드 + solo 폴백 30초 유예(초기 마운트 제외) +
  전역 done은 endEditing 요청에만 반응(Save는 편집 유지).
- 테스트(c5-4 신규 5종, red 확인 후 green): U-flush-race / U-flush-clean(0회·507ms) /
  U-close-save(409→복구 200) / U-offline-long(적응형 120s+30s 대기→resume→배너, chromium+msedge) /
  O-1(Ada→Grace 승계→재입장). R-ribbon/follow/attach lock-in 포함.
- 회귀: c5-4 전체(chromium, 변경분 msedge) · xlsx-collab(X2a-6 기존 제외) ·
  pptx-collab(신규 0; D26/E3/E12/E18/E16b/E20s/E21/E8/E9/모바일 3종 베이스라인 동일 실패) ·
  c5-1/2/3 · c3 · presence · c4-3/4/6 · xlsx-c2/solo · ui-layout.
  backend unit collab 전종 green, frontend tsc 0, backend tsc 기존만, eslint 동일, encoding/memory clean.
- 주의: setOffline은 WS를 끊지 않는다 — B4류 테스트는 rooms 목록 소멸 poll + TTL 여유로.
 동기 dispatch 이벤트는 리스너를 먼저 등록할 것.

## C6 Word 동시편집 (2026-11-06, D68)
- C6-0 정리: handoff C5-4c절 UTF-8 재작성(깨진 절 복구), encoding 검사 보강
 (TextDecoder fatal strict 판정 + 유효-UTF-8 오독 글리프(U+020E/022D) 경고),
 eslint 기준선 332 problems = 272e+60w 유지(C6a에서 C6 신규 exhaustive-deps 3건을 제거하고 복원).
 Q01(410 스텁 유지 — D04 자동선출 유효, v0.13에서 제거 여부 판단),
 Q02(part 참조 전환 보류 — W3 측정 선행, v0.13),
 Q03(H2 보기 공용 경로 유지 — W0-4 viewer-first로 검증됨, 남은 일 없음).
- 0절 측정(C6a 항목별 확정, dist 근거):
 | 항목 | 판정 | 처리 | 근거 |
 | 본문 텍스트/서식/표 | O | fragment 동기 | Y.XmlFragment "docx:body" — ooxml-core/dist/docx/ui/index.mjs WordYjsCollaboration 생성자 + W0-2 |
 | 본문 이미지 | O | media 맵(신규) + 동일 원본 매칭(기존) | WordYjsMedia.publish/get — ooxml-core yjs-media.d.ts ("Loaded package assets stay in the matching source package") |
 | 코멘트 | O | Yjs 동기 (C6 초기 기록 X는 오기) | 방 identity가 항상 independent/inline-relative 기록 → sharedComments=true — ooxml-core ui/index.mjs identity.set 블록 + 생성자; canEditComments 허용 — ooxml-ui docx.js (e2e 미커버, 남은 일) |
 | 문서 루트 속성(trackChanges 토글 등) | O(신호) | attributes 맵 동기 | wordYjsDocumentAttributes 별도 맵 ("body binding omits them") — ooxml-core yjs-document-attributes.d.ts |
 | 머리글/바닥글 | X | lib 차단 + 리본 숨김 12종 + 토스트 | fragment 밖 + canEditOutsideBody collab 중 false — ooxml-ui docx.js 4곳(toggleLink/headerFooter/insertNote/updateNote) |
 | 각주/미주 | X | lib 차단 + 리본 숨김(insert-footnote/insert-endnote) + 토스트 | 위와 동일 |
 | 구역/단/페이지설정/페이지테두리 | X | 리본 숨김 + 토스트 | layout(model.sections) 미동기 — sections.d.ts/section-edit.d.ts 계열이 fragment 밖 |
 | 변경추적 토글/해결/옵션 | X(보수 차단) | 리본 숨김 7종 + 토스트 | 토글 신호(attributes 맵) 동기 가능하나 accept/reject 동기 미검증 → W3에서 해소 |
 | 스타일 정의 | 해당 없음 | 수정 UI 없음 | RIBBON_ACTION_IDS에 style 수정 id 없음(적용만 — 적용은 본문 서식이라 O) |
 | 워터마크 | X | 리본 숨김 + 토스트 | section 속성 |
 | undo/redo | 동기 범위만 | 우회 불가 (W0-6 단언) | UndoManager 추적 = fragment/attributes/comments/inlineAnchors — index.mjs 생성자 |
- 테스트(test 커밋 3026ccc5 + C6a test 커밋): docx-collab W0-1~W0-9a/9b + presenceGate 단위 4건 +
 R-ribbon solo 슬롯 단언. red 원문(제품 stash = a3c8813 동일):
 W0-1 line 111 participantCount poll timeout, W0-9 line 348 동일,
 R-ribbon line 1136 app-titlebar-slot attached 60s timeout, unit 4 failed(import).
 C6a red: W0-6 line 249 insert-footnote hidden 포함 실패(가드+8 미적용 상태).
- W0-4 증거(viewer-first): B가 view로 먼저 입장(participant 1) → A가 edit로 seed+입력 →
 B 화면에 w04-mark 표시(새로고침 없음, 90s 내). W0-5 증거(http): page URL protocol http
 확인 + w05-mark 입력→저장→word/document.xml 디스크 판정.
- R-ribbon 회귀(C6 미커밋 코드, 커밋 전 해소): 빈 presence Shell/Bar를 슬롯에 무조건 포털 →
 타이틀바 밀림 328px. 바이섹트 제외 항목(join HTTP·세션/startYjs·hiddenActions prop·
 value import·etag prop·viewer.ts openFile 분기 — 전부 꺼도 재현, 베이스라인 동시간 4회 passed).
 수정: shouldShowPresence 공용 게이트 + R-ribbon solo 0개/W0-1 joined 1개 DOM 단언 + W0-9a/9b.
- code 커밋 366a8ecf: 서버 RoomKind/isLibRoomKind, DocxViewer join/session/저장/가드/첨부,
 docxTapTransport.ts(구 docxObjects.ts — 제품 코드: tap transport 103/104 가로채기 + 100/101 소비.
 xlsx createObjectTapTransport와 armFlushAck/스켈레톤 중복 → v0.13에서 공통 모듈 병합 검토),
 collabPresenceView shouldShowPresence (xlsx 게이트도 여기로 통합).
- 회귀: docx 10/10 (chromium — W0-5 flake 1회, 단독 재실행 green) · msedge W0 전부 ·
 R-ribbon 양쪽 · X-B2 · c5-4 24/24 · c5-1/2/3 · c3 26/26 · xlsx-collab 19/19 양쪽 ·
 pptx-collab 26/26(신규 0) · presence 4/4 · ui-layout 3/3 · collab 백엔드 단위 59/59 ·
 presenceGate 4/4 · tsc 0 · encoding clean.
 office-embed.test.ts 1건 실패(assembleXlsxEmbed '/oleObject' 미포함)는 베이스 동일 실패 — 기준선 추가.
 0.12.82 exe 대신 b397a694 worktree(제품 diff 0) 나란히 샷: solo 140px(Share 버튼 AA, benign),
 2인 846px(GR 아바타 추가 — 의도된 UI). 다음부터 태그 버전 exe 보관.

## C6a 태그 전 확인 (2026-11-07)
- W0-9 분리: W0-9a(순수 offline→재연결, 폴백 없음. D07 25초 sweep + 여유 60s poll) +
 W0-9b(닫고 다시 열기). chromium·msedge 모두 통과. 30초 미전파는 D07 설계 범위 내
 (lastRxAt 기준 25초 무수신이면 서버가 sweep으로 정리 — setOffline 후 25~30초에 감소 관측이 정상).
- encoding red: 18a8292 handoff — 구 검사기 관점 FFD 315개, 신 검사기 fatal decode 실패.
 둘 다 못 잡는 유효-UTF-8 오독 Ȯ 2건 → U+020E/022D 경고 패턴 추가(D68 한계 보완).
- eslint: C6-0 332(60w) → C6 335(63w, 신규 3건 전부 C6 exhaustive-deps) → C6a에서 제거 후 332 복원.
 제거된 3건: joinDocxRoom 불필요 의존성 standalone / session effect 누락 collab(collabRef로 대체) /
 docxHiddenActions 누락 DOCX_UNSYNCED_ACTION_IDS(모듈 스코프 이동).
- docxTapTransport 개명(역할 일치) + armFlushAck 중복 병합은 v0.13/W3로 이연(xlsx 경로 동결).
- Q01/Q02/Q03: 위 C6절 결정 참조. 남은 일 — Q01: v0.13 스텁 제거 판단 / Q02: W3 측정 후 전환 / Q03: 없음.

## C6b 도형 dblclick + 리본 늘어짐 수정 (2026-11-07, D69)
- 증상 2건(사용자 샷): (1) PPTX embedded docx 도형 dblclick → 무응답. lib dblclick이
 OLE에 no-op이라 편집 진입이 Properties "Edit content..." 버튼에만 있었다.
 (2) ~900px 창에서 리본이 세로로 늘어남(160→223px, Font/Clipboard 스택).
- 수정1(우리 코드): OleAttachmentOverlay 컨테이너 캡처 dblclick 라우팅(pptx만).
 posMap rect 히트 → 칩과 같은 openOrDownload(새 탭 편집/미리보기/다운로드).
 lib 푸터 버튼 위 dblclick은 lib 동작 유지. 순수 함수 findOleEntryAtPoint + 단위 6건.
 CFB(oleObject) 임베딩은 편집 미지원(서버 GET이 CFB를 풀지 않음) — 다운로드는 된다.
- 수정2(lib 패치): ooxml-ui ribbon CSS 5곳
 `@media (pointer:coarse),(max-width:900px)` → `@media (pointer:coarse)`
 (터치 44px 유지, 데스크톱 좁은 창은 22px 한 줄 + 그룹 접기). .mjs/.cjs 쌍.
- 테스트: c5-4에 U-open-part-pptx-shape + R-ribbon-narrow 추가(chromium+msedge green).
 red 원문: popup 15s timeout / clipboard 작은 버튼 min-height 44px.
- 주의: pnpm patch-commit이 행에 걸려 패치 파일만 커밋되고 설치 반영이 안 됐음 —
 live node_modules(.pnpm/ooxml-ui@1.8.0_…) 2파일을 수동 동기화함.
 fresh `pnpm install`은 patches/*.patch에서 재생성되므로 소스는 패치 파일.
- 회귀: 위 D69 참조. 남은 순서: 0.12.83 exe 재빌드(본 수정 포함) → 푸시 → PC 2대
 수동확인 → v0.12.83 태그(버전 bump 없음 — 태그 전이므로 같은 버전으로 재빌드).

## C6c 하위문서 공동편집 (2026-11-07, D70)
- 요구: /edit/부모/-/파트 새 탭 두 개가 같이 편집되게. 권한 체크는 나중.
 URL 규칙(/edit/문서·/edit/부모/-/파트 모두 무조건 편집모드)은 이미 성립 — 변경 없음.
- 서버: 파트 방(roomIdForPart, kind=파트 확장자). seed/lastHash/저장/disk/watcher
 전부 파트 바이트 기준. 저장=replaceEmbedPart+부모 방 adopt+reset (PUT과 동일),
 부모 flush/dirty 검사도 PUT과 동일 순서. /save dirty_room 메시지는 기존 PUT UX
 문구('부모 파일을 먼저 저장하세요') 그대로 둔다.
- 클라이언트: AttachmentEditor가 파트 세션 선점 → 성공 시 잠금 없이 viewer 방 모드
 (path=부모+part+etag, standalone=false), 실패 시 기존 잠금+PUT 폴백.
 stale은 에러+다시 열기. viewer 3종 part 대응(세션/nested attach/officeSaveRequest/
 registerSaver). PptxViewer 세션키는 파트별로 분리한다.
- 테스트: backend 단위 8건(roomId/세션 host·guest·stale·list/저장·conflict·부모adopt) +
 e2e P-open-part-coedit(두 탭 동시입력+저장, docx 파트) + E2-join(E2-lock 교체).
 red 원문:popup timeout(무응답→join 확인) / stale_client 404 아님(host/guest 확인).
- 회귀: backend unit 신규 실패 0(기존 3파일 실패 동일: bun:sqlite 2 + office-embed
 기준선 1). e2e: c5-4 25/26(U-open-part-pptx 풀런 플레이크, base 동일) · c5-3 15/16
 (E2-pdf-preview base 단독 실패) · c5-1 5/5 · c5-2 P2-3/P2-5 단독 green ·
 xlsx-ole-solo 2/2 · ui-layout 3/3 · docx-collab 10/10 · pptx-collab 27 ·
 R-ribbon-narrow + U-open-part-pptx-shape green 유지.
 U-stale-1은 새 의미(막힘+배너/토스트, 새로고침 없음)로 갱신. E2-join으로 교체된
 E2-lock(독점 잠금)은 의도된 동작 변경이다.
- 남은 일: 권한 체크(v0.13 이후, 사용자 지정) — 파트 방 참가 시 역할 판정.
 CFB(oleObject) 파트 편집 미지원(기존) — 다운로드만 된다.

## K-dbl 삽입첨부 dblclick (2026-11-07)
- 삽입 직후(새로고침 없음) lib 도형 dblclick → 새 탭 첨부 URL → 편집·저장 → 부모 zip 반영. PPTX/XLSX/DOCX 각 1건 (e2e/collab/k-dbl.spec.ts).
- 판정 포인트 3개: (1) docx 파트 단언은 바이트 includes가 아니라 태그 제거 텍스트 비교(partTextContains) — delay 타이핑이 <w:t>에 쪼개져 raw 바이트 매칭이 실패한다. 제품은 정상이었음. (2) xlsx/docx 호스트는 lib이 삽입물을 렌더하지 않아 오버레이 칩(getByRole button /이름/)이 타겟이다. (3) xlsx 테스트 타이핑은 본문 텍스트 클릭+Home 제스처만 확정 (contenteditable 클릭+Control+End는 포커스 미스).
- 제품 변경: OleAttachmentOverlay 앵커 매칭 보강(이름 우선+progId 확장자, docx ole placeholder) + oleMatch 순수함수(frontend/src/lib/oleMatch.ts, 단위 6건). plain.docx 픽스처(중첩 OLE 없음) 추가 — 중첩 OLE 파트 저장은 lib yjs 바인딩 이슈로 별도 추적.
- 결과: k-dbl 3/3 (chromium), oleMatch 6/6.


## C6c-a0 K-dbl 보완 (2026-11-07)
- 중첩 OLE(embed-docx.docx, live w:object): 저장 200 + 파트 73615→73712 + 안쪽 document.xml 마커 포함(strip 포함) + 안쪽 임베딩 보존(word/embeddings/Microsoft_Word_Document.docx, w:object 유지). 조용한 유실 아님. 과거 실패 판정은 앵커 미스 시절 + raw-includes 단편화 오판이었음. K-dbl-nested로 회귀 고정.
- URL: D64(/edit/ + /-/) 유지가 현재 스킴. 사용자 지시 /{상위}/{하위} 전환(D71)은 C6c-a 이후로 연기됨. GET /api/collab/resolve 신설(서버가 단일 진실, shared/src/lib/editPath.ts) — 테스트는 서버 판정으로만 URL을 해석한다(partPathOf/정규식 단언 제거). 한글·공백 왕복은 단위 테스트로 증명, 라우트 우선순위·/edit/ 리다이렉트는 D71로 이월.
- 라벨 dblclick: 캡션이 rect 바깥이라 컨테이너 캡처에 안 걸림 → 캡션 자체 onDoubleClick + pointer-events:auto/zIndex(조상 none 상속·lib 토스트 가림 대응). pptx는 lib 호환성 토스트를 닫고 누른다. K-dbl-docx는 시트 XML 텍스트 단언으로 강화(바이트 변화만 보지 않음).

## C6c-a P0 (2026-11-07)
- P0-1: 부모 경로 단위 저장 직렬화. 부모 방+모든 파트 방이 같은 체인 공유(saveChains, parentChainKey). flush 응답 저장(pendingFlush 보유)은 체인을 건너뛴다(교착 방지 — 체인을 잡은 파트 저장이 그 응답을 기다림). red: 동시 저장 3라운드 중 1회 유실 → fix 후 5/5 green.
- P0-2: PPT 낡은 저장 차단. baseHash-vs-room 대조를 pptx에도 적용(conflict_room). epoch 별도 대조 없음 — epoch이 바뀌는 리셋은 lastHash도 함께 갱신하므로(바이트가 같으면 무해) baseHash로 충분. red: 낡은 baseHash 저장 성공 → fix 후 conflict_room.
- P0-3: 리셋 빈도 계측(resetStats total/disruptive/lastAt, /api/collab/rooms 노출) + 무접속 리셋 스킵(lastHash adopt만, 방 유지). 기존 테스트 1건이 옛 동작(항상 dispose)을 단언해서 새 요구사항에 맞게 갱신. defer(조용한 구간/Done/마지막 퇴장)는 미구현 — 미반영 구간 표시 UI도 그에 묶여 보류. 근거: 현재 미반영 구간은 저장 직후 부모 리로드까지 수초이며 EMBED_DONE 토스트+재조회가 이미 알림+반영을 담당한다.
- P0-4: subtle 없는 http도 strict. knownHash 없이 strict만 오면 서버가 디스크/파트 해시를 직접 구해 판정하고 serverHash로 돌려준다. 클라이언트는 serverHash를 origPartHash 대신 쓴다(AttachmentEditor). red: serverHash 없음 → fix 후 2/2.
- 중첩 OLE와 P0-1/P0-2는 원인 다름(중첩은 테스트 단언+앵커 문제였고 저장 경로는 정상). 같이 고칠 것 없음.

## P0-1c 파트 flush 순환대기 해소 (2026-11-08)
- U-flush-race 4연속 실패(red원문): 3초 지연 루트 아래 수동+자동저장+flush 저장이 한꺼번에 도착하면 첫 승자 외 전부 409-conflict. 패자의 ok:false done에 attach 재시도 대기가 포기했고(trace: 두 attach PUT 다 dirty_room, 부모 PUT 3개가 파트 flush 타임아웃까지 체인에 묶임), flush는 8.0초+ε에 수렴해 타임아웃으로 죽었다.
- 원인 2개, 둘 다 수정: (1) 서버 — 파트 저장이 체인을 잡고 flush(최대 8초)를 기다리면, 그 flush에 필요한 부모 저장이 같은 체인 뒤에 줄서는 순환대기. 판정(flush/깨끗체크)만 체인 밖에서 먼저 하고, 체인은 읽기-검사-쓰기만 직렬화한다 (PUT /save 파트분기 + PUT /embed 동일). 겹쳐쓰기는 baseHash 잠금 + 쓰기 체인이 막는다. (2) 클라이언트(AttachmentEditor.waitParentSaveDone) — 실패 done에 포기하지 말고 성공까지 대기 + 내부 중복 officeSaveRequest 제거.
- 테스트: backend 단위 3건 green (신규 nochain 1 + gate 개정 2 — 구 큐잉 단언 "flush 중 일반 저장은 기다린다"를 새 동작 "바로 끝난다"로 갱신). e2e U-flush-race chromium+msedge 2 passed (47.1s). 회귀 매트릭스는 아래 C6c-b 항목에서 계속.

## P0-1c-3 dirty_room 상한 + retryable (2026-11-08)
- U-flush-race 수정 뒤에도 attach 재시도 대기가 때로 영원히 끝나지 않을 수 있어 상한을 둔다. `waitParentSaveDone`을 `officeSave.ts` 공용으로 옮기고 기본 30초 + 실패 done 무시.
- collabApi.save가 서버 `dirty_room`을 `currentHash` 탓에 `conflict`로 오인하던 매핑을 고쳤다 (서버 코드를 reason으로 살림).
- xlsx/docx saveViaRoom + PptxViewer.persistBytes + AttachmentEditor.persist의 dirty_room에 상한 대기 후 1회 재시도. 그래도 안 되면 기존 내 사본 경로로 끝난다.
- red: U-dirty-timeout(부모 저장 영구 실패) — 수정 전 468/503ms 만에 포기(no mine) → 수정 후 상한 대기 후 내 사본, 양쪽 green (1.9분).
- U-close-save 회귀 발견: 닫힌 부모는 절대 수렴하지 않는데 30초를 기다려 20초 단언이 깨졌다. 서버 gate가 `retryable`을 싣는다 (편집자 있음 true/없음 false). false면 즉시 실패(기존 `부모 파일을 먼저 저장하세요` 토스트), true일 때만 대기+재시도. 단위 red 2건 → green. U-close-save + U-dirty-timeout 4 passed (2.7분).
- 단위 가드 추가: 파트 PUT body는 inner 바이트 (outer 통째 아님) + 디스크에 부모(G)+파트(E) 마크 보존 단언.

## C6c-b 1~6 대조표 (2026-11-08)
- 1) 무접속 dispose 원복 + 30초 reopen: 완료. `resetRoomByServer`는 항상 dispose, 집계만 conns>0일 때 (collab-rooms.ts 1324~1343). red `collab-reset-frequency.test.ts` 3 its green (무접속 dispose / 카운터 / 닫음→첨부저장→재입장 가시+낡은 owner 차단).
- 2) 리셋 빈도 2분 disruptive 원문: 완료. 임시 프로브(부모 열어둠 + 2인 첨부편집 흉내, 매 10초 부모+파트 저장, 12라운드) — `rounds=12 elapsedMs=124604 resetStats={"total":12,"disruptive":12,"lastAt":...}`, 디스크 양쪽 마크 보존. (프로브 파일은 삭제, 원문만 기록.)
- 3) requestId 짝짓기: 유지. P0-1c 이후 체인은 쓰기 구간(ms)만 잡으므로 매칭 응답이 막힐 일이 사실상 없고, 막혀도 baseHash 대조가 순서를 보장한다. 우회는 그대로 둔다 (gate 단위 테스트 round 2가 커버).
- 4) P0-4 knownHash: 완료. AttachmentEditor 155~160 GET ETag→knownHash(strict), strict-http 단위 3 its green (GET 발급/신선도/stale 판정).
- 5) pptx conflict_room 토스트 + 사본 e2e: 완료. PptxViewer 562~565 notice+mine, pptx-stale 단위+e2e green.
- 6) 캡션 단언: 완료. e2e k-dbl 9 passed (캡션 라벨/아래 dblclick 3개 스텝 포함) + frontend oleHitTest 8 its (padBottom 2건 포함, 단 frontend 단위 러너 없음).
- flake 3건 × 3회: U-open-part-pptx (chromium 3/6 pass, msedge 0/5 — insert saveFirst vs seeding 레이스, msedge는 item-3 제거 베이스라인에서도 실패로 코드 무관 확정), E2-join (chromium 3/3, msedge 1/3 — B 탭 포커스 미스, trace로 키입력 미도달 확인), nosubtle (3/3 양쪽 green — 단발성 부하).
- 빠진 매트릭스: c5-1+c5-2+ui-layout 28 passed / c4-3 20 passed / c4-4+c4-6 34 passed + G2 2건 기존실패(베이스라인 동일) / docx-collab 20 passed / xlsx-collab 36 passed + X0a-9·X2a-6 4 failed(저장 경로 무관 타이밍, isolated X0a-9 chromium pass) / c3 54 passed / pptx-collab 절반A 12 passed + E21b·E3·E8·E9 8 failed(베이스라인 동일) / 절반B 크로미움 E12·E18·E16b·E21·모바일×3 실패(베이스라인 동일) + E13~E20 6 passed(msedge) / c5-4 X묶음 18 passed + U-close-save 2 failed→retryable 수정 후 green / c5-4 Y묶음 16 passed(R-ribbon 포함) / backend 전체 702 passed + 3 기존환경실패(bun:sqlite 2 + oleObject 1) / tsc backend 기존에러만·frontend clean / eslint 변경파일 clean(신규 warning 0, 베이스라인 대조) / encoding 통과.
- PC 2대 수동 목록에 추가: "부모 문서를 계속 편집하는 동안 다른 PC에서 첨부 저장" (이번 교착 상황).

## P0-1c 회귀 매트릭스 (2026-11-08)
- backend 전체: 702 passed / 3 실패는 전부 기존·환경 문제 (bun:sqlite 없음 config-migration·repo-tracking 스위트 2건 — node 실행 환경, office-embed assembleXlsxEmbed `/oleObject` 1건 — office-embed.ts는 node:zlib/crypto만 import, 수정 모듈과 무관).
- e2e: U-flush-race 2 passed / U-flush-clean 2 passed / U-parent* 4 passed / P-open-part-coedit* 6 passed / c5-3 31 passed + E2-join 1 flake(단독 2 passed) / K-dbl 9 passed + nosubtle 1 flake(단독 2 passed) / c5-4 전체 39/58까지 1 실패(U-open-part-pptx msedge만 — INSERT 후 ole-icon 개수, PUT 무관·단독재실행도 msedge만 빨강/chromium green, 기존 msedge 렌더 flake).
- check-encoding + check-memory-rules 통과 (오류 0).

## C6c-1 deferred parent reset (2026-11-09)
- ����: ��Ʈ ���帶�� �θ� ���� ��� 4001+dispose�ؼ�, Ÿ���� ���� �θ� ȭ���� �ٽ� �ҷ������� (�ӽ� ���κ�: rounds=12, resetStats={total:12,disruptive:12} / 124s).
- ����: ��Ʈ ������ �θ� zip�� ��� adopt�ϵ�, �����ڰ� �ְ� �Է� ���̸� �� ������ ������ ����(5�� ���Է�)���� �̷��. Ʈ���� 3��: ������ ���� Ÿ�̸�(�� ���� �ϳ�, �����), ÷�� �� ����(��Ʈ �� empty), (�θ� ������ ������ sweeper�� �ñ�). ���� ����.
- �̷��� ����: roomMeta + ���� ���信 hasPendingPartChange�� �ƴ´�. pptx�� meta��, xlsx/docx�� ���� �������� ��ʸ� �Ҵ� (�ٽ� �ҷ����� ��ư ����).
- red: collab-part-reset-defer.test.ts - �θ� �Է� �� ÷�� ���� 3ȸ -> ���� 0ȸ, ���������� 1ȸ, ���� ��ũ ���� (���� ��: �� ���帶�� �������� red). backend ��ü 706 passed (���� ȯ�� ���� 3�Ǹ�).
- e2e ��Ȯ��: P-open-part-coedit 6 passed, U-flush-race/U-close-save/U-dirty-timeout/U-flush-clean 8 passed, K-dbl 9 passed + nosubtle flake 1��(�ܵ� 2 passed, full ���� ����).

## C6c-d deferred-window parent merge (2026-11-09)
- ���� 2�� (���� ����): (��) �̷��� ���� �θ� �ڵ������� 409�� ��� �����ϰų� (��) ����ؼ� ��ũ�� �� ÷�θ� �� ����Ʈ�� ���´�. ���� �׽�Ʈ�� ���� ��ũ ������ adopt �� ��ũ���� �θ� ����Ʈ�� �о�ͼ� �� ��츦 �˻����� �ʾҴ�.
- ����: �̷��� ���� �θ� ������ adopt �� �ؽõ� �޾��ְ�(1ȸ�� �Һ� ? bases ����, ���� 8), ��ũ�� adopt ��Ʈ�� ���� �θ� zip�� �ٽ� ���� ����. bases�� ���� base���ٸ� Ÿ���ǽ�Ʈ�� ���� base�� ������� 409. �̷����� ����(Ŭ���̾�Ʈ�� ���� �� ��Ʈ).
- �̷��� ���� ������ ���� �� ��� dispose�Ѵ� (TTL 30�� ��Ⱑ �� Y+�� lastHash ���� ���� ������ ������ ����� C6c-b 1�� ����). ������ ���� Ÿ�̸Ӱ� ��� �ٽ� ���۵ŵ� ù �̷�+60�� ���ѿ� ���µȴ� (Ÿ�̸Ӹ�, ���� ����). ��� �ٽ� �ҷ����� = ��� ���� (pptx ���� WS 101, xlsx/docx�� POST /:room/reset-pending ? �����ڸ�, ���� �� ���� �翬��).
- red ���� 4�� (collab-part-reset-merge.test.ts): stale-base ���� ����, ���� �� ���� ����+���� base 1ȸ�� �Һ�(�� ��° Ÿ���ǽ�Ʈ 409 �� ��õ� ����), ������ ���� ��� dispose, ���� ��� ����. red e2e 4�� (e2e/collab/c6d.spec.ts): D1 xlsx/docx/pptx (���� �Է� �� ÷�� 2ȸ ���� ? 409 0ȸ������ ��ũ �������Է� �� ���� 0ȸ������ �� ���� 1ȸ), D2 ������ ���� ��� dispose �� 10�� �� ������. pre-fix���� (��)/(��) ��η� red Ȯ��.
- backend ��ü 710 passed (�ű� 4 ����, ���� ȯ����� 3�Ǹ�: bun:sqlite 2 + assembleXlsxEmbed 1).

## D-���: Edge ÷�� �õ� 15�� �Ѱ� (C6c-3)
- Edge���� ÷�� ���� ���� �õ尡 15�� �ȿ� �� ������ U-open-part-pptx�� �����Ѵ� (msedge ���� ü��: ���� lib init). ���� �� msedge 5/5 green(35~39��)������ ���ϰ� �ؽ��ϸ� �õ� Ÿ�Ӿƿ��� �ɸ� �� �ִ�. �� ��� ������ ���а� �ƴ϶� ������ �佺Ʈ�� ������. ���� �׽�Ʈ������� PC������ ��õ� 1ȸ�� �����Ѵ�.

## C6c-3 Ŀ�� ���� (�±� �� ���� �亯)
- 11a52372 (23:32, +91/-6): 1�� ���� ���� ? waitForSessionSynced ���� ��� ��ȯ(���� ����) + onSave/saveViaRoom ���� early-return ���� ��� ok:false done (����ڰ� 30�ʸ� ��ٸ��� �ʰ�). officeEmbed.ts + DocumentPreview.tsx + PptxViewer.tsx.
- b01d4264 (23:50, +46/-10): 18�� �� �ٺ����� ���� ? (1) onSave�� stale saving Ŭ������ ���� ������ ���� ������ ���� �� ref �񱳷� ����, (2) serializer �ڵ������� done�� ���� ���� �� �Ϸ� �� done ����. �õ� ��� ���� ���. PptxViewer.tsx + officeEmbed.ts.
- e7aca73b�� 3��°: ������ �� ������ ��ŵ �� �ٷ� POST (flake �ֹ� ����). 3���� red test Ŀ���� ���� ���� ? red �ٰŴ� e2e trace(saveFirst#2 ���� �α� ����) + pre-fix msedge 5ȸ(4 fail + 1 pass)�̸� 11a52372 �޽����� ����ߴ�.
- nosubtle (P0-4 ���� ���): full ���� ���࿡�� 1�� ������ �� ����. �̹� �� full ���� 3ȸ ���� green���� �ܾ� ���� ��Ȯ��. ��Ŀ������ full ���� ���� �� crypto.subtle Ÿ�̹� flake�̸� �ܵ� ����� green (���� ��ϰ� ���� ����).

## PC 2�� ���� Ȯ�� (v0.12.83 �±� ��)
- 1: Edge���� ������ ���ڸ��� �ٷ� ÷�� �����ϱ�.
- 2: �θ� 1�� �Ѱ� ��� Ÿ�����ϴ� ���� �ٸ� PC���� ÷�� ���� �� ���� �� �θ� ���� ���� �佺Ʈ ����, Ÿ���� ���߸� �� ���� ���ΰ�ħ, ���� ���� ����.
- 3: �̷��� ����(÷�� ���� �̹ݿ� ��ʰ� ���̴� ����)���� �θ� �ݰ� �ٷ� �ٽ� ���� �� �� ÷�ΰ� ���̰� ������ ���� �ʴ���.
- 4 (C6c-e 추가): 부모 타이핑 중 다른 PC에서 첨부 여러 번 저장 → 60초 안에 자동으로 다시 불러와질 때, 그 직전에 친 글자와 새 첨부가 모두 남는지.

## C6c-e 리셋 경계를 넘어온 옛 저장 차단 (2026-11-09, epoch 대조)
- red 먼저: 단위 collab-epoch-stale.test.ts 3건 red→green (stale base=M + 옛 epoch → pre-fix 200 덮개, post-fix 409 stale_client). e2e D3-pptx 1건: 리셋 경계를 넘긴 옛 저장을 HTTP로 직접 재현 — pre-fix 200 무음 덮개(red, 디스크 b1 소실), post-fix 409 stale_client + 디스크 보존 + 재저장 200 (green).
- item 2 e2e D4-pptx: 미룸 중 부모 탭 닫기 → 즉시 dispose 증명(늦은 저장 404 fail-closed), 재입장 후 epoch 변경 + 정상 저장 + 디스크 첨부 보존.
- item 3 단위 1건: 미룸 중 첨부삭제 — rel 없는 파트는 다시 끼우지 않음 (200, 디스크에 부활 없음).
- 회귀: backend 전체 715 중 기존 실패만 (office-embed 1 + bun:sqlite collection 2). c6d 6/6 (D1×3 + D2 + D3 + D4). c5-3 16/16 (E2-pdf 1회 flake, 재실행 green). c5-4 29 + U-parent 기존실패 1. k-dbl: K-dbl-xlsx flake (pre-fix 트리 동일 실패 확인 — 내 변경 무관), 외 green. xlsx 19 + X2a-6 기존실패 + X0a-9 flake(단독 green). docx W0 10/10. pptx 27 + 베이스라인 11 실패 집합 일치. tsc clean, eslint 신규 0, encoding 이상 없음(기존 PptxViewer 큰따옴표 경고 1건 유지).
## C6c-f 태그 전 작은 묶음 (v0.12.83 태그 전)
- item 3 부모 저장 epoch 필수: POST /save가 부모 방 저장에 epoch 없으면 400 epoch_required (파트 방 제외). 호출점 대조: frontend 6곳 전부 epoch 전송 중(수정 없음), backend relay 테스트 9곳에 epoch 추가, 신규 단위 T2i(바이너리+JSON 400, epoch 있으면 200). red(200)->green(400) 분리 커밋.
- item 1 가드: reloadAfterServerReset는 현재 세션과 같은 경우만 full reload, 아니면 토스트만. D5 e2e: 늦은 stale 409를 주입해도 중복 불러오기 없음(count==1). pre-fix count 4(red)->post-fix 1(green).
  - 하네스 교훈: 수동 route.continue()/unrouteAll({behavior:'wait'})/headerValue()는 요청 소실·교착을 일으킨다. fulfill(확정 응답)과 플래그 통과 + 핸들러 내 즉시 continue만 쓴다. __collabDebug 미러는 ?collabDebug=1일 때만 기록되므로 단언에 쓰지 않는다 (서버 rooms API·카운터로 판정).
- item 2 미뤄진 리셋 전 flush(103→104, 8초 예산): doDeferredParentReset가 flushThenResetParent로 103을 보내고 ack를 기다린 뒤 4001. 실패하면 reason embed_reset_unflushed로 닫고, 클라이언트는 사본 다운로드+배너("마지막 변경이 반영되지 않았을 수 있음"). 재입장 뒤에도 유지(Dismiss 때 해제). 파트 방·무접속 방은 제외(받을 탭이 없음).
  - 단위: defer 테스트의 mock conn이 103에 104로 답한다 (동기 ack는 B1 짝짓기에 버려지므로 비동기+300ms 지연. 즉시 ack는 adopt 타이밍을 깨뜨려 즉시 리셋한다).
  - D6 e2e Phase A(상한): flush 시도 프로토콜 지문(officeSaveRequest flushRequestId) 관측 + 재입장 + 디스크 보존. Phase B(flush 타임아웃): 배너+사본 링크. pre-fix red: Phase A flush 없음(75s poll timeout), Phase B 배너 없음.
  - 꼬리 바이트를 디스크 단언에서 뺀 이유: 네트워크 홀드(5s+)는 freshness proxy(타임스탬프 대조)를 깨뜨려 낡은 저장이 flush를 조기 확정한다. 홀드 없는 자동저장 꼬리는 타이밍 비결정적이라 flush 시도 자체(103→officeSaveRequest)를 단언한다.
  - 사본 링크 레이스 수정 2건: (1) 103 시점 getContent 스냅샷 + promise 대기 (2) unflushed 경고의 재입장 유지.
- item 4: 198ec78(D4 신설 +115: 미룸 중 부모 탭 닫기→즉시 dispose/늦은 저장 404/재입장 정상) vs 341b49b(D4 보정 +12/-2: B PUT 전 자동저장 수렴 대기, 닫기 전 타이핑으로 in-flight 경합 재현, dialog 핸들러 들여쓰기 포맷). T2i 2-space 통일.
- 회귀: backend 전체 716 중 기존 실패만(bun:sqlite collection 2 + assembleXlsxEmbed 1; merge deadline 1건은 내 변경 영향이라 104-ack 추가로 수정 후 green). c6d 8/8 (D1×3 + D2 + D3 + D4 + D5 + D6). c5-3 16/16 (E2-pdf flake 단독 green). c5-4 28 + P-open flake(단독 green) + U-parent 기존실패 1. k-dbl 5/5. xlsx 19 + X2a-6 기존실패. docx W0 10/10. pptx 27 + 베이스라인 11 실패 집합 일치(presence·UI 타임아웃, 단독 재실행 E21b 동일 실패 — 내 변경 경로 아님). tsc clean, eslint 신규 0 (PptxViewer 기존 1 error + 9 warnings 유지), encoding 이상 없음(T2h 깨진 문자 3줄 복원).
- C6N lib peer 미반영 배너 (신규): xlsx/docx peer는 type 100 meta를 받지 못해 첨부 미반영 배너를 볼 수 없었다(저장 때만 갱신). adopt-미룸 시 lib 방에 105 part-pending을 방송하고, transport(docxTapTransport/xlsxObjects)가 받아 배너를 띄운다. 재입장 시 배너 해제. 단위 red(105 없음)→green. pptx는 meta 경로 그대로.
- icon 통일 (신규): pptx ole 프레임이 2"x1.39" 문서 모양으로 그려져 xlsx(2열x3행 앵커)와 달라 보였다. pptx 프레임을 1.42"x0.71" 아이콘 크기로 축소 + 미리보기 PNG를 192px로(고DPI). 단위 red(구 치수)→green. 스크린샷으로 렌더 확인(96x48 표시).
## C6c-f 보고 누락분 (2026-11-10)
- D5 red 원문: pre-fix `expect(await resetCount()).toBe(1)` → Expected 1, Received 4 (late stale이 reload를 4회 유발). post-fix 1 (no double reload).
- D6 red 원문: pre-fix `expect.poll(flushSeen, 75s)` → Expected true, Received false (103 자체가 없음). post-fix flush observed → reset → phase A/B green.
- epoch 호출점 대조표 (전부 세션/방 epoch 전송, 누락 없음):
  - PptxViewer.tsx:633 persist `c.epoch` / :639 conflict 재시도 `c.epoch`
  - DocumentPreview.tsx:1299 docx 저장 `room.epoch` / :1314 재시도 `room.epoch`
  - DocumentPreview.tsx:3220 xlsx 저장 `room.epoch` / :3232 재시도 `room.epoch`
- release/.env 원복 확인: health 체크용 PORT=5123 임시 변경 후 PORT=5002로 원복 (파일 내용 확인済).

## C6N lib peer 미반영 배너 (2026-11-10)
- 원인: lib 방(xlsx/docx)은 type 100 meta를 모르므로 미룸 알림을 못 받았다 (pptx는 meta로 수신). 새로고침해야만 보였다.
- 수정: adopt defer 시 lib 방에 105 part-pending 방송 + transport가 받아서 배너 표시. 재입장한 방에는 addConn 시점에 105 재전송 (늦은 참가자/재연결 대응). 배너 해제는 새 세대에서만 (같은 세대 재연결은 유지).
- test: defer 105 단위 (pre-fix found=[] red→green), late joiner 단위 (red→green), e2e D7 (pre-fix banner timeout red→green, 31s).
- POST /embed(신규 삽입)는 미룸 경로를 타지 않음 (collab.ts:508-512 즉시 resetRoomByServer). 미룸 진입은 PUT /embed→adoptParentPartAndMaybeReset 하나뿐. e2e D8로 증명: 타이핑 중 삽입 → 양쪽 0.1s 내 반영 (5s 기준 green).

## 아이콘 통일 2:1 (2026-11-10)
- 원인: pptx ole 프레임이 2"x1.39" 도형 크기라 문서 그림처럼 보임. xlsx 앵커(~2:1)가 아이콘처럼 보임.
- 수정: pptx extCx/extCy 1296000x648000 (2:1) + VML 102x51pt, 미리보기 PNG 192x96 2:1로 재설계 (프레임과 동일 비율 → 찌그러짐 없음), docx 96x48pt.
- 단위: 프레임 cx/cy + PNG IHDR 192x96 assert (pre-fix 값으로 red 확인 후 green). 스크린샷으로 렌더 확인 (96x48 아이콘 + 클립 + 파일명).
- 실기 PowerPoint 확인은 사용자 측에서 (0.12.83 exe에 포함 예정).
