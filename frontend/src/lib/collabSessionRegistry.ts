import type { YCollabSession } from './ycollab'

/**
 * 2-2: 탭당 파일당 세션 1개.
 * 인라인 미리보기와 전체화면이 같은 파일을 동시에 열면 세션이 2개 생겨
 * 같은 사람이 두 명으로 표시된다(awareness clientID가 다르므로 dedupe 전까지는 2명).
 * 여기서 경로별로 세션을 1개만 만들어 공유한다.
 */
interface RegistryEntry {
  session: YCollabSession
  refs: number
}

const registry = new Map<string, RegistryEntry>()

/** 이미 살아있는 세션을 얻거나 새로 만든다. 새 세션이면 onCreate로 설정한다. */
export function acquireCollabSession(
  path: string,
  make: () => YCollabSession,
  onCreate: (session: YCollabSession) => void,
): { session: YCollabSession; reused: boolean } {
  const existing = registry.get(path)
  if (existing) {
    existing.refs += 1
    return { session: existing.session, reused: true }
  }
  const session = make()
  registry.set(path, { session, refs: 1 })
  onCreate(session)
  return { session, reused: false }
}

/**
 * 방이 해체된 세션을 명시적으로 버린다(M2-2).
 *
 * 4001 reset은 서버가 방을 없앴는데 같은 경로로 다시 들어오게 된다. release를
 * 거치지 않으면 죽은 세션이 registry에 남아 재사용된다(refs가 늘어나 언마운트로도
 * 안 지워진다). 이 함수는 항목을 즉시 제거하고 세션을 파괴한다.
 */
export function dropCollabSession(path: string, session: YCollabSession): void {
  const entry = registry.get(path)
  if (!entry || entry.session !== session) return
  registry.delete(path)
  session.destroy()
}

/** 참조를 내려고, 마지막 참조면 세션을 파괴한다. */
export function releaseCollabSession(path: string, dispose: (session: YCollabSession) => void): void {
  const entry = registry.get(path)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs > 0) return
  registry.delete(path)
  dispose(entry.session)
}

/** 디버그/테스트용: 현재 유지 중인 세션 수. */
export function collabSessionCount(): number {
  return registry.size
}