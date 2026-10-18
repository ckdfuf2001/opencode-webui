import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
// 테스트마다 새로 만드는 격리 워크스페이스 (spec의 WORKSPACE_PATH).
export const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collabe2e-'))
// 백엔드는 시작 시 저장소 트리를 스캔해 children 을 채운다(FileTree.tsx:150).
// children 이 [] 로 스캔된 폴더는 needFetch=false 이므로 이후에 파일을 심어도
// 절대 다시 조회되지 않는다. 그래서 **서버가 뜨기 전에** 파일을 심어야 한다.
// 이 probe 파일로 트리가 실제로 자식 행을 그리는지 확인할 수 있다.
const probeDir = path.join(wsDir, 'repos', 'collab-e2e')
fs.mkdirSync(probeDir, { recursive: true })
const probeFixture = path.join(here, 'fixtures', 'collab-features.xlsx')
if (fs.existsSync(probeFixture)) {
  fs.copyFileSync(probeFixture, path.join(probeDir, 'probe-seeded-before-server.xlsx'))
}
process.env.COLLAB_E2E_WS = wsDir

const BACKEND_PORT = 5011
const FRONTEND_PORT = 5183
// dev(5001/5173/5554)와 겹치지 않는 E2E 전용 포트.
const OPENCODE_PORT = 5564

export default defineConfig({
  testDir: '.',
  testMatch: ['pptx-collab.spec.ts', 'xlsx-solo.spec.ts'],
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
      env: { E2E_BACKEND_PORT: String(BACKEND_PORT) },
    },
  ],
})
