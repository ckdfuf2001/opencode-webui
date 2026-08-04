# Architecture Guide

OpenCode WebUI 의 구조, 데이터베이스, 그리고 개발 시 유의점을 정리한 문서입니다.

- [프로젝트 구조](#프로젝트-구조)
- [실행 구조 & 포트](#실행-구조--포트)
- [데이터베이스](#데이터베이스)
- [설정 동기화 흐름](#설정-동기화-흐름)
- [개발 시 유의점](#개발-시-유의점)

---

## 프로젝트 구조

pnpm 워크스페이스 (Bun 백엔드 + React 프론트 + 공유 패키지) 로 구성되어 있습니다.

```
opencode_web/
├── backend/                 # Bun + Hono REST API (포트 5001)
│   ├── src/
│   │   ├── index.ts         # 엔트리포인트: 서버 기동, DB 초기화, 기본 config 시드
│   │   ├── db/              # SQLite 스키마/쿼리/마이그레이션
│   │   ├── routes/          # Hono 라우트 (repos, settings, files, providers, ...)
│   │   ├── services/        # 비즈니스 로직 (repo, settings, files, proxy, ...)
│   │   ├── utils/           # logger, process 관리
│   │   └── types/           # Zod 스키마 기반 타입
│   └── scripts/             # Python 사이드카 (doc_converter.py, doc_reader_mcp.py)
├── frontend/                # React + Vite + Tailwind + Radix UI (포트 5173)
│   └── src/
│       ├── api/             # REST 클라이언트 + opencode OpenAPI 타입
│       ├── components/      # UI (ui/, message/, file-browser/, settings/, ...)
│       ├── hooks/           # React Query / SSE 로직 (useOpenCode, useSSE, ...)
│       ├── pages/           # Repos, SessionDetail 등 화면
│       ├── lib/             # 템플릿, 토스트, 파서 등
│       └── stores/          # Zustand 전역 상태
├── shared/                  # 양쪽이 공유하는 패키지 (@opencode-webui/shared)
│   └── src/
│       ├── config/          # env, defaults (포트, 경로, 제한값)
│       ├── schemas/         # Zod 스키마 (설정, 파일, repo ...)
│       └── types/
├── scripts/                 # 개발/설치 스크립트
│   ├── setup-dev.bat/.sh    # 환경 준비 (의존성, agent-browser, MCP 등록)
│   └── register-default-mcp.js
├── config-templates/        # MCP 등록용 템플릿 (git 추적)
├── data/                    # SQLite DB (git-ignored)
└── workspace/               # 열린 저장소 + opencode 설정 (git-ignored)
```

### 로컬 파일이 git에 안 올라가는 것 (참고)

`.gitignore` 에서 `data/`, `workspace/`, `bin/`, `.env`, `*.db` 는 모두 제외됩니다.
즉 **DB·workspace·runtime config 는 저장소에 커밋되지 않습니다.** 이 때문에
문서(`architecture.md`, `README.md`) 와 템플릿(`config-templates/`) 이 설정을
"설명/재현"하는 역할을 합니다.

---

## 실행 구조 & 포트

```
Browser ─────────> Frontend (Vite :5173)
                      │  /api/* (same-origin 프록시)
                      ▼
                    Backend (Bun+Hono :5001)
                      │  /api/opencode/* (proxyRequest)
                      ▼
                    OpenCode Server (:5551)   ← cwd = workspace/
                      │  MCP stdio 부프로세스 실행
                      ▼
              python doc_reader_mcp.py / agent-browser mcp
```

| 포트 | 역할 | 기본값 | 실제(.env) |
|------|------|--------|-----------|
| 5001 | WebUI 백엔드 API | 5003* | 5001 |
| 5173 | Frontend (Vite) | 5173 | 5173 |
| 5551 | opencode 서버 (백엔드가 spawn) | 5551 | 5551 |

> \* `shared/src/config/defaults.ts` 의 `SERVER.PORT` 는 5003 이지만, 실제
> `.env.example`/`.env` 에서는 5001 로 덮어씁니다. 기본값을 그대로 쓸 것이라면
> 5001 이 아니라 5003이 됨에 주의하세요.

---

## 데이터베이스

단일 SQLite 파일 (`data/opencode.db`, 기본 `./data/opencode.db`) 을
**Bun 내장 `bun:sqlite`** 로 직접 사용합니다. (ORM 없음)

스키마는 `backend/src/db/schema.ts` 에 정의되고, `runMigrations()` 가 컬럼/
인덱스 누락 시 자동 보완합니다.

### 테이블

**`repos`** — 등록한 저장소
- `id`, `repo_url`, `local_path` (NOT NULL), `branch`, `default_branch`
- `clone_status` (NOT NULL: cloning/cloned/failed), `cloned_at`, `last_pulled`
- `opencode_config_name`, `is_worktree`, `is_local`
- 유니크 인덱스: `(repo_url, branch)` 부분, `local_path`

**`user_preferences`** — 사용자 선호 (테마, 모델, 단축키 등)
- `id`, `user_id` (UNIQUE, 기본 'default'), `preferences`(JSON), `updated_at`
- DB 초기화 시 `'default'` 유저가 자동 생성됨

**`opencode_configs`** — opencode 설정 여러 개 + 기본값 지정
- `id`, `user_id`, `config_name` (UNIQUE(user_id, config_name))
- `config_content`(JSON), `is_default`, `created_at`, `updated_at`
- 앱 설정 UI 는 **이 테이블** 을 읽습니다.

### 주요 원칙

- **DB 가 설정의 source of truth** (아래 동기화 흐름 참고)
- `bun:sqlite` 는 동기 API — 워커/트랜잭션 없이 단일 연결로 순차 처리
- 마이그레이션은 `PRAGMA table_info` 로 컬럼 존재 여부를 검사해 추가하는
  "멱등(idempotent)" 방식

---

## 설정 동기화 흐름

**DB ⇄ runtime 파일 ⇄ opencode 서버** 의 관계가 헷갈리기 쉬운 부분입니다.

```
앱 설정 UI (DB 읽음)
   │ 저장
   ▼
DB (opencode_configs)          ← source of truth
   │ syncDefaultConfigToDisk() (백엔드 시작 시)
   ▼
workspace/.config/opencode/opencode.json   ← opencode 서버가 실제 읽는 파일
   │ OPENCODE_CONFIG 환경변수로 주입
   ▼
opencode 서버 (:5551)
```

- **백엔드 시작 시**: `ensureDefaultConfigExists()` → DB에 config가 없으면
  기본 config를 생성. 있으면 **기본 MCP(`agent-browser` 등)가 없으면 병합**.
  이후 `syncDefaultConfigToDisk()` 로 DB의 기본 config를 runtime 파일에 덮어씁니다.
- **설정 UI에서 저장**: `PUT /api/settings/opencode-configs/:name` → DB 갱신 →
  기본 config면 파일에 쓰고 `patchOpenCodeConfig()` 로 서버에 반영. MCP 변경 시
  opencode 서버를 재시작(`opencodeServerManager.restart()`).
- **MCP 등록**: `register-default-mcp.js` (setup 시 1회) 와
  `config-templates/opencode.mcp.*.json` 은 새 클론에서 기본 MCP를
  재현하기 위한 도구입니다.

> ⚠️ **실수하기 쉬운 점**: runtime 파일(`workspace/.config/opencode/opencode.json`)
> 만 직접 바꾸면, 백엔드 재시작 시 DB가 그 파일을 덮어써서 변경이 사라집니다.
> **앱 설정에 반영하려면 DB를 바꿔야** 합니다. (agent-browser 가 UI에 안 보이던
> 원인이 바로 이것입니다.)

---

## 개발 시 유의점

### 일반 코드 스타일 (AGENTS.md)
- 주석 없이 self-documenting 하게 작성
- 엄격한 TypeScript, 모든 곳에 명시적 타입
- named import 만 사용 (`import { Hono } from 'hono'`)
- DRY, 기존 패턴 준수

### 백엔드 (Bun + Hono)
- Hono + Zod 검증, `try/catch` + 로깅 구조
- 기존 `routes / services / utils` 구조 따르기
- `async/await` 일관 사용 (`.then()` 체인 금지)
- **DB 접근은 `bun:sqlite` 단일 연결** — 병렬 트랜잭션 지양
- **Port 5001** 기준으로 개발 (기본값 5003 주의)

### 프론트 (React + Vite)
- `@/` alias로 import: `import { Button } from '@/components/ui/button'`
- Radix UI + Tailwind, React Hook Form + Zod
- **React Query** 로 상태 관리 (직접 상태 변경 금지)
- ESLint TypeScript 규칙 준수 (`npm run lint`)
- SSE 기반 실시간 업데이트는 `useSSE.ts` 에서 관리

### opencode 서버 연동
- opencode 서버는 **싱글 전역 서버** (`OpenCodeServerManager` 싱글턴), 레포별 아님
- 프록시는 `backend/src/services/proxy.ts` — `/api/opencode/*` 경로를
  opencode 서버로 전달 (시간: `AbortSignal.timeout`)
- CWD 는 `workspace/` — **상대경로는 workspace 기준**

### 문서/템플릿 관리
- 설정 관련 내용은 `README.md` 와 `architecture.md` 양쪽에 반영
- MCP 를 새로 "기본 등록" 하려면:
  1. `backend/src/index.ts` 의 `DEFAULT_OPENCODE_CONFIG.mcp` 에 추가 (DB 시드)
  2. `config-templates/opencode.mcp.<name>.json` 생성 (git 추적)
  3. `frontend/src/lib/mcpServerTemplates.ts` 에 UI 프리셋 추가
  4. `scripts/register-default-mcp.js` 에 병합 대상 추가
  5. `README.md` / `architecture.md` 문서화