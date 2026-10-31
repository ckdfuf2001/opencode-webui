import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
// 테스트마다 새로 만드는 격리 워크스페이스 (spec의 WORKSPACE_PATH).
//
// M9/6절 하네스 복구: 이 설정 파일은 **메인 프로세스와 각 워커에서 다시 평가된다.**
// 그래서 mkdtempSync 를 매번 부르면 워크스페이스가 둘 이상 생긴다.
//   - 메인 프로세스 것 → webServer(백엔드)가 쓰는 실제 워크스페이스
//   - 워커 것         → spec 의 freshFile() 이 파일을 쓰는 곳
// 둘이 다르면 새 파일이 백엔드에 안 보이므로 파일 트리에 안 떠서
// helpers/viewer.ts 의 파일 행 클릭이 타임아웃한다(닫힌 폴더 토글 문제와 겹쳐 보임).
// → 첫 평가(메인) 때 한 번만 만들고 COLLAB_E2E_WS 로 공유한다.
export const wsDir = process.env.COLLAB_E2E_WS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'collabe2e-'))
const wsOwner = !process.env.COLLAB_E2E_WS
process.env.COLLAB_E2E_WS = wsDir
// 백엔드는 시작 시 저장소 트리를 스캔해 children 을 채운다(FileTree.tsx:150).
// children 이 [] 로 스캔된 폴더는 needFetch=false 이므로 이후에 파일을 심어도
// 절대 다시 조회되지 않는다. 그래서 **서버가 뜨기 전에** 파일을 심어야 한다.
// xlsx(X-B1)와 pptx(M6) 양쪽 스펙이 이 파일을 쓴다.
const probeDir = path.join(wsDir, 'repos', 'collab-e2e')
fs.mkdirSync(probeDir, { recursive: true })
const seedFile = (fixture: string, as: string): void => {
  const src = path.join(here, 'fixtures', fixture)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(probeDir, as))
}
if (wsOwner) {
  seedFile('collab-features.xlsx', 'probe-seeded-before-server.xlsx')
  seedFile('collab-3slides.pptx', 'probe-seeded-before-server.pptx')
}

const BACKEND_PORT = 5011
const FRONTEND_PORT = 5183
// dev(5001/5173/5554)와 겹치지 않는 E2E 전용 포트.
const OPENCODE_PORT = 5564

export default defineConfig({
  testDir: '.',
  testMatch: ['pptx-collab.spec.ts', 'xlsx-solo.spec.ts', 'xlsx-collab.spec.ts', 'viewer-unmount.spec.ts', 'ui-layout.spec.ts', 'presence.spec.ts', 'xlsx-c2.spec.ts', 'c3.spec.ts', 'c4-3.spec.ts', 'c4-4.spec.ts'],
  retries: 0,
  workers: 1,
  // E5가 30초 입력 + 저장 대기를 하므로 여유를 둔다.
  timeout: 180_000,
  expect: { timeout: 3000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: './playwright-report' }]],
  // Q4: Chrome(Chromium)과 Edge 둘 다 실행 — 이미지(data: URL) 렌처 브라우저 차이가 있던 사례.
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'msedge', use: { browserName: 'chromium', channel: 'msedge' } },
  ],
  use: {
    baseURL: `http://127.0.0.1:${FRONTEND_PORT}`,
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
    actionTimeout: 10000,
  },
  // 규칙 0: 테스트가 만든 임시 WORKSPACE는 종료 시 지운다 (성공 산출물도 남기지 않는다).
  globalTeardown: './helpers/teardown.ts',
  webServer: [
    {
      command:
        'node --disable-warning=ExperimentalWarning --experimental-transform-types --import ./scripts/node-compat/register.mjs backend/src/index.ts',
      cwd: repoRoot,
      port: BACKEND_PORT,
      timeout: 180_000,
      reuseExistingServer: false,
      env: {
        PORT: String(BACKEND_PORT),
        // backend/index.ts ensureEnvFile이 .env(PORT=5001)로 덮으므로 전용 var로 지정.
        E2E_BACKEND_PORT: String(BACKEND_PORT),
        OPENCODE_SERVER_PORT: String(OPENCODE_PORT),
        WORKSPACE_PATH: wsDir,
        DATABASE_PATH: path.join(wsDir, 'e2e.db'),
      },
    },
    {
      command: `pnpm --filter frontend exec vite --port ${FRONTEND_PORT} --strictPort`,
      cwd: repoRoot,
      port: FRONTEND_PORT,
      timeout: 180_000,
      reuseExistingServer: false,
      // VITE_E2E=1 → 앱의 E2E 모드(알림 배너·토스트 끄기, 선택적 fetch 콘솔 레벨 완화).
      // 스펙이 어떤 URL 로 가더라도 적용되도록 쿼리 파라미터 대신 env 로 넣는다.
      env: { E2E_BACKEND_PORT: String(BACKEND_PORT), VITE_E2E: '1' },
    },
  ],
})
