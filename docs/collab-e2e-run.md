# 공동편집 E2E 직접 실행 방법

대상: `e2e/collab/pptx-collab.spec.ts` (E1~E15 + 모바일 E11m, 총 17개).
명세는 `docs/collab-e2e.md`, 케이스 정의 표는 그 문서 4장·6장을 볼 것.

## 1. 준비

- dev 서버(5001/5173)는 켜져 있어도 된다. E2E는 자체 포트를 쓴다.
- **BrightVPN은 잠시 꺼둘 것을 권장.** 켜져 있으면 loopback 연결이 간헐 차단
  (`EACCES`, SYN 블랙홀)돼서 테스트가 실패한다. 관련 금지 규칙은 없다.
- 처음 한 번만: `npx playwright install chromium`
  (이미 설치돼 있으면 스킵. 모바일 `isMobile`은 chromium에서만 된다.)

## 2. 실행

```bash
# 전체 (17개, 직렬)
bun run test:e2e:collab

# 하나만
bun run test:e2e:collab -g "E1: participants"

# flake 검증 (완료 보고 전 3회 연속 통과)
bun run test:e2e:collab --repeat-each=3

# 목록만
bun run test:e2e:collab --list
```

- 실패하면 `test-results/`에 스크린샷·trace가 남는다 (gitignore).
  trace 보기: `npx playwright show-trace test-results/<test-dir>/trace.zip`
- 반영 지연은 테스트 출력의 `[latency]` 줄과 `test-results/` 로그로 본다.

## 3. 하네스 구조

| 항목 | 내용 |
|---|---|
| 설정 | `e2e/collab/playwright.config.ts` (`retries: 0`, `workers: 1`, timeout 180초) |
| 포트 | backend 5011, frontend 5183, opencode 5565 (dev 5001/5173/5554와 분리) |
| 격리 | `WORKSPACE_PATH`를 임시 디렉터리로 매번 생성, `DATABASE_PATH`도 분리 |
| fixture | `e2e/collab/fixtures/collab-3slides.pptx` (생성기 `make.ts`, 3장 고정) |
| 파일 분리 | 각 테스트가 fixture를 `repos/collab-e2e/<케이스>-<시각>-<번호>.pptx`로 복사 |
| 헬퍼 | `helpers/env.ts` (경로), `users.ts` (Ada/Grace), `viewer.ts` (열기/이동/편집/지연), `disk.ts` (디스크 검증) |

## 4. 알아둘 것

- `E2E_BACKEND_PORT`: backend `index.ts`의 `ensureEnvFile()`이 `.env`를
  `override: true`로 읽어서 프로세스 env의 `PORT`를 덮어쓴다. 그래서 E2E용
  포트는 전용 변수로 넘긴다 (vite도 같은 변수로 백엔드를 찾는다).
  dev/prod에는 영향 없다 (변수가 없으면 기존 동작).
- `cmd`에서 수동 기동할 때 `set VAR=값 &&` 끝에 공백이 값에 포함된다
  (trailing space). 꼭 `set "VAR=값"` 형태로 쓴다.
- `5011 is already used`가 나오면 이전 실행의 webServer 잔재다.
  해당 node 프로세스를 죽이고 재실행한다.
- VPN을 켠 채로 돌리면 `ERR_NETWORK_ACCESS_DENIED` / `EACCES` / 타임아웃이
  간헐적으로 나온다. 테스트 로그의 `[WebServer] ... proxy error`와
  `console.error Failed to load resource`는 이 경우 환경 산출물로 보고
  넘어간다 (스펙의 허용 목록도 같은 취지). `pageerror`는 엄격히 본다.

## 5. 수정 전 실패 확인 (§5)

```bash
git worktree add D:/Local/Temp/prefix-1259 v0.12.61
cd D:/Local/Temp/prefix-1259
# E2와 E5만 legacy 단언으로 실행 (신규 testid 없이 동작하는 대체 경로).
# 기대: E5 실패 (setSavedBytes 저장 때마다 리로드), E1/E3/E8/E10은 "해당 없음".
```

- worktree에는 `.env`가 없으므로 backend는 기본 포트(5002)로 뜬다.
  dev(5001/5173)와 겹치면 `PORT`/`--port`를 옮겨서 띄운다.
  (단, legacy 코드에는 `E2E_BACKEND_PORT`가 없어서 vite 프록시는
  `PORT` env를 따라간다.)
