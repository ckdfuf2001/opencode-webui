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
