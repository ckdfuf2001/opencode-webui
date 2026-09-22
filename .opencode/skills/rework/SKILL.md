---
name: rework
description: Re-apply post-v0.10.33 work onto the v0.10.33 base without S2 workspace-forcing. Use when continuing the 0.11.0 rework: porting fixes, phase gates, verification.
---

# 0.11.0 rework skill (base: v0.10.33)

## Golden rules

1. **S2는 제외한다.** 세션 cwd 강제 주입(`sessionCreateRepoDir` 강제·workspace-root 통일) 관련 코드는 가져오지 않는다. 세션은 각 레포 디렉토리에서 자연 생성되고, 해석 루트는 `workspace/repos`다.
2. **1 작업 = 1 커밋**, 영역 prefix (`fix(chat):`, `fix(permission):`, `feat:`, `docs:`, `chore:`).
3. **재현 없이 수정 금지.** live면 형태 포착(watcher/probe) 후 판정.
4. 판단 분기마다 로그. 무음 `return`/무음 catch를 새로 만들지 않는다.
5. `edit`/`write` 도구로만 파일 편집 (PowerShell Get/Set-Content 영구 금지 — 한글 파괴 전적).
6. 실행 중 서버 kill·실행 중 exe 덮어쓰기·합의 없는 history rewrite 금지.
7. 검증 4종 통과해야 커밋: `tsc -b` · backend `vitest run` (신규 테스트 포함, `bun:sqlite` 2파일 제외) · 파일 인코딩 검사 (U+FFFD 0개) · live probe 전/후 대조.

## Source material

- 전체 목록: `git log --oneline 7281263..backup/pre-v33-reset` (62 commits)
- 원본 보기: `git show <sha> -- <path>`
- 가져오기: `git cherry-pick -n <sha>` 후 S2 잔재 제거·어댑트, 검증, 커밋
- 백업 기준점: `backup/pre-v33-reset` (절대 삭제 금지)

## Phase order (순서 엄수 — 의존성 순)

### Phase 0 — observability + safety (먼저, 동작 변경 최소)
- `b6b16dd` orphan sweep 빈-DB 가드 → 그대로 cherry-pick
- `80a0035`+`1c6dc63` 관측 장비 (`GET /api/system/logs`, `--define PACKAGE_VERSION`, AGENTS.md 절차)
- 검증: suite + `/api/system/logs` 200 + `/api/system/info` version 표시

### Phase 1 — paths foundation
- `17eab6e` workspaceRel + `7c597c5` repoPath shared + `cd28023` 빌드 서브패스
- `a7b7524` S1 매핑 (**자연 dir 기준**으로 해석 — S2 강제 없음)
- `9bc0298` S3+S4 (workspace 규약 주입 + 레지스트리; 강제 관련 줄 있으면 제거)
- `716d161` S5 멘션 wsPath + `246f34b` sending 멘션
- `e94c0dc` 멘션 칩 존재 확인
- 검증: dev에서 repo 생성→세션 cwd가 repo dir인지 확인 + doc-reader 6종 probe

### Phase 2 — doc-reader + permission stack
- `eccec1d` + `9f565ed` (resolve + REPOS env) — 완료 (v0.11.3)
- `5724839` veto bypass → **제외 확정**. S2 가드레일 자체가 없으므로 예외도 불필요.
- `9e071d7` sweep (S2 제외 적응: quiet + getSessionRepo-first만, 가드레일 제외)
- `e7eb0f3`+`aacf12a` config render + review 반영, `f385cb7` directories
- `cc4ae0d` 쓰기 단일 큐 (부팅 sync·CRUD·수기 저장 직렬화)
  자연 cwd에서 전역 `*` 룰은 사용자 명시 선택으로 그대로 둔다.
- config render 적용 시 **object-capable allowlist 필수** (`bash/edit/read/external_directory`만
  객체 맵, 나머지는 스킵+warn). 근거: opencode 1.18은 `permission.webfetch` 객체를
  `ConfigInvalidError`로 거부하고, 그 뒤 모든 세션 생성이 400으로 막힌다 (dev 실측).
  string 전체허용으로 접지 말 것 (과다 허용).
- opencode는 config를 메모리에 들고 있어서 파일 수정 후에도 **서버 재시작 전까지**
  구값이 유효하다. e2e 검증은 재시작 후 판정.
- e2e probe가 공용 dev 파일/DB를 건드리면 바이트 단위로 원복한다 (DB row 포함).
- 검증: vitest + CRUD→opencode.json 실측 + live ask 포착 판정

### Phase 3 — chat behaviors
- `47c767f` edit/truncate, `6553189` reload 반영, `5fd3353`/`3f85c71` 커맨드칩
- `b4a2e63` rank, `35ccbe0`+`d13aefe` SessionList, `6f83680` question descendants
- `2f46e4f` 중 repo-sessions (repo dir 1순위 유지 + wsroot strict 보조), full-output stopPropagation, model override
- `7f3e98f` twin-drop 가드, `41e723f`+`390f27c` 빈응답 가드
- 검증: 해당 화면 실측 + suite

### Phase 4 — explorer + status + misc
- `53ca4f0` refresh, `2f945f9` 펼침 스토어, `d49d8e7` sort, `dabcdec` #id
- `3c6f31c` playwright chromium, `c3ba7f3` 연결 failureCount
- `3fda4ab` 차단확장자, `a4c6101` Permissions 라우팅, `3f83536` SSE 기본값, `deee04f` subtree 변형
- `c0ae431` sanitize + boundary

### 제외 (가져오지 않음)
- `d115359` S2 강제 전체 (proxy sessionCreateRepoDir 강제 + 관련 주석/테스트)
- `c01e9d2`, `4833d4e` zip 바이너리 커밋 (git 추적 제외 유지)
- 버전 bump 커밋들 (0.11.0에서 새로; `2fb4973` zip untrack은 이미 반영됨 — `.gitignore`/`*.zip` 상태 확인만)

## S2 잔재 검사 (cherry-pick마다 수행)

가져온 diff에 다음이 있으면 제거·어댑트한다:
- `sessionCreateRepoDir`, `getWorkspacePath()` 로 directory 덮어쓰기
- "S2" 주석이 강제 의미를 담고 있으면 자연-cwd 의미로 고친다
- `resolveRepoId` 호출부가 강제 전 값을 기대하면 자연 dir로 바꾼다
- 관련 테스트의 workspace-root 가정 (`. artificially` 픽스처 등)

## Release (0.11.0)

1. dev soak (수용 기준 전부 + 무제보 기간)
2. `0.11.0` bump + tag
3. portable build → `rank` 200 + 지문 확인 → DB 백업 → swap → smoke 3종
4. 태그 푸시. 바이너리 zip은 git에 포함하지 않는다.

## Live 포착 프로토콜 (재현용)

- ask/팝업: living-list 폴링으로 형태 확보 후 판정. 뜨면 바로 누르지 말고 보고.
- 고착: 건드리지 말고 보고. 세션 상태·큐·마지막 메시지 플래그를 그 순간에 읽는다.
