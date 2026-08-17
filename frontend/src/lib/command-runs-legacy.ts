import { createCommandRun } from '@/api/command-runs'

const LEGACY_KEY = 'opencode-webui-command-runs'

interface LegacyRun {
  id: string
  sessionID: string
  name: string
  args?: string
  startedAt?: number
  directory?: string
  repoId?: number
}

/**
 * zustand persist 로 localStorage 에 쌓여 있던 command run 기록을
 * 서버 DB 로 1회 이관한다. 성공 시 키를 제거해 재실행되지 않게 한다.
 */
export async function migrateLegacyCommandRuns(): Promise<void> {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(LEGACY_KEY)
  } catch {
    return
  }
  if (!raw) return

  try {
    const parsed = JSON.parse(raw) as { state?: { runsBySession?: Record<string, LegacyRun[]> } }
    const bySession = parsed.state?.runsBySession ?? {}
    const all = Object.values(bySession).flat()

    for (const run of all) {
      if (!run?.sessionID || !run?.name) continue
      try {
        await createCommandRun({
          sessionId: run.sessionID,
          commandName: run.name,
          args: run.args,
          directory: run.directory,
          repoId: run.repoId,
        })
      } catch {
        // 개별 실패는 무시하고 계속 진행
      }
    }

    localStorage.removeItem(LEGACY_KEY)
    if (all.length > 0) {
      console.info(`[commandRuns] migrated ${all.length} legacy runs to server`)
    }
  } catch {
    localStorage.removeItem(LEGACY_KEY)
  }
}
