import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
// 테스트마다 새로 만드는 격리 워크스페이스 (spec의 WORKSPACE_PATH).
export const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collabe2e-'))
fs.mkdirSync(path.join(wsDir, 'repos'), { recursive: true })
process.env.COLLAB_E2E_WS = wsDir

const BACKEND_PORT = 5011
const FRONTEND_PORT = 5183
// dev(5001/5173/5554)와 겹치지 않는 E2E 전용 포트.
const OPENCODE_PORT = 5564

export default defineConfig({
  testDir: '.',
  testMatch: 'pptx-collab.spec.ts',
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
    screenshot: 'only-on-failure',
    actionTimeout: 10000,
  },
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
