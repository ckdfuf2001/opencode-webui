// `pnpm dev`용: 백엔드(/api/health)가 뜰 때까지 프론트 시작을 늦춘다.
// vite가 먼저 뜨면 폴링(/api/session-status, /api/health)이 프록시 에러를
// 쏟아낸다. 서비스엔 무해하지만 기동 로그가 지저분해지므로 순서 보장.
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function portFromEnvFile() {
  try {
    const envPath = join(root, '.env')
    if (!existsSync(envPath)) return null
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*PORT\s*=\s*(\d+)\s*$/)
      if (m) return Number(m[1])
    }
  } catch {}
  return null
}

const port = Number(process.env.PORT) || portFromEnvFile() || 5002
const url = `http://127.0.0.1:${port}/api/health`
const timeoutMs = Number(process.env.WAIT_BACKEND_TIMEOUT_MS) || 180_000
const intervalMs = 500

const started = Date.now()
for (;;) {
  try {
    const res = await fetch(url)
    // 리스닝 중이면(상태코드 무관) 라우트 등록된 것이므로 출발
    if (res.status < 500) {
      console.log(`[wait-backend] backend ready (${url} -> ${res.status})`)
      process.exit(0)
    }
  } catch {}
  if (Date.now() - started > timeoutMs) {
    console.error(`[wait-backend] backend not ready after ${Math.round(timeoutMs / 1000)}s (${url})`)
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, intervalMs))
}
