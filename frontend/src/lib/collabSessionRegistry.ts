import type { YCollabSession } from './ycollab'
import { tl, tlStack } from './collabTimeline'

/**
 * 2-2: 탭당 파일당 세션 1개.
 * 인라인 미리보기와 전체화면이 같은 파일을 동시에 열면 세션이 2개 생겨
 * 같은 사람이 두 명으로 표시된다(awareness clientID가 다르므로 dedupe 전까지는 2명).
 * 여기서 경로별로 세션을 1개만 만들어 공유한다.
 *
 * M3/N1: release는 **경로가 아니라 토큰(lease)** 으로 한다.
 * 경로 기반 releaseCollabSession은 "내가 acquire를 했는지" 알 수 없어서, acquire하지
 * 않은 뷰어가 언마운트할 때 남의 refs를 깎아 편집 중 세션을 죽일 수 있었다.
 * 이제 acquire가 돌려주는 lease가 자신의 세션과 1회성 release를 함께 가진다.
 */
interface RegistryEntry {
  session: YCollabSession
  refs: number
  /** N2: 방이 해체돼 같은 세션을 쓰는 다른 뷰어들에게 통지할 콜백. */
  notifyReset: Set<(reason: string) => void>
  /** drop/release 로 세션이 죽었다. 늦게 구독해도 바로 알려 주기 위한 플래그. */
  dead: boolean
}

const registry = new Map<string, RegistryEntry>()

/**
 * acquire의 결과. release()는 자신이 잡은 그 entry만 해제하며 두 번 호출해도 무효다.
 */
export interface CollabSessionLease {
  session: YCollabSession
  reused: boolean
  /** N2: 이 세션이 방 해체(4001)로 버려졌을 때 통지받으려면 등록한다. */
  onReset: (fn: (reason: string) => void) => void
  /** 1회성 해제. 내가 acquire하지 않았거나 이미 해제했으면 아무 일도 하지 않는다. */
  release: () => void
}

const graceState = new WeakMap<
  RegistryEntry,
  { timer: ReturnType<typeof setTimeout> | null; idle: (() => Promise<boolean>) | null }
>()

export function acquireCollabSession(
  path: string,
  make: () => YCollabSession,
  onCreate: (session: YCollabSession) => void,
  opts?: { idle?: () => Promise<boolean>; graceMs?: number },
): CollabSessionLease {
  const existing = registry.get(path)
  const entry = existing ?? (() => {
    const session = make()
    const e: RegistryEntry = { session, refs: 0, notifyReset: new Set(), dead: false }
    registry.set(path, e)
    onCreate(session)
    return e
  })()
  // M31 1-a: 유예(grace) 중에 같은 path 로 다시 acquire 하면 타이머를 취소하고 세션을 재사용한다.
  const gs = graceState.get(entry)
  if (gs?.timer) {
    clearTimeout(gs.timer)
    gs.timer = null
    tl('session.grace_cancel', { path, clientId: entry.session.clientId })
  }
  entry.refs += 1
  const session = entry.session
  const reused = Boolean(existing)
  let released = false
  // M11 계측: 세션 획득/참조 증가.
  tl('session.acquire', { path, reused, refs: entry.refs, clientId: session.clientId, stack: tlStack(3) })

  return {
    session,
    reused,
    onReset: (fn) => {
      // 이미 버려진 세션이면 늦게 구독해도 바로 알려 준다(죽은 세션을 조용히 들고 있지 않게).
      if (entry.dead) {
        fn('dropped')
        return
      }
      entry.notifyReset.add(fn)
    },
    release: () => {
      // 1회성. StrictMode 이중 cleanup이나 중복 호출에 안전하다.
      if (released) return
      released = true
      // M11 계측: 해제.
      tl('session.release', { path, refs: entry.refs, clientId: session.clientId, stack: tlStack(3) })
      // drop 이후 같은 경로에 새 세션이 들어와 있을 수 있다. 그 entry를 건드리면 안 된다.
      if (registry.get(path) !== entry) return
      if (entry.refs > 1) {
        entry.refs -= 1
        return
      }
      entry.refs = 0
      // M31 1-a: 즉시 destroy 하지 않는다.
      // 언마운트 뒤 도착하는 lib flush(deadline 2초)를 받쳐야 하므로 유예(기본 3초)를 둔다.
      // 유예가 lib flush 상한(2초)보다 길어야 "아직 오지 않은 flush" 를 받을 수 있다(D45).
      // 같은 path/epoch 재acquire 시 위에서 타이머가 취소된다.
      // 4001 리셋은 dropCollabSession 이며 **유예 없이 즉시** destroy 한다(D41).
      const graceMs = opts?.graceMs ?? 3000
      const state = graceState.get(entry) ?? { timer: null, idle: opts?.idle ?? null }
      if (opts?.idle) state.idle = opts.idle
      graceState.set(entry, state)
      if (state.timer) clearTimeout(state.timer)
      state.timer = setTimeout(() => {
        state.timer = null
        void (async () => {
          // 유예 만료: 저장이 유휴가 될 때까지 기다린 뒤 파괴한다(최대 3초).
          for (let i = 0; i < 30; i++) {
            const busy = await state.idle?.()
            if (busy !== true) break
            await new Promise((r) => setTimeout(r, 100))
          }
          if (registry.get(path) !== entry) return
          if (entry.refs > 0) return
          registry.delete(path)
          entry.dead = true
          entry.notifyReset.clear()
          tl('session.destroy', { path, reason: 'grace_expired', clientId: session.clientId })
          session.destroy()
        })()
      }, graceMs)
    },
  }
}

/**
 * 방이 해체된 세션을 명시적으로 버린다(M2-2 / M3-N2).
 *
 * 4001 reset은 서버가 방을 없앴는데 같은 경로로 다시 들어오게 된다. release를
 * 거치지 않으면 죽은 세션이 registry에 남아 재사용된다(refs가 늘어나 언마운트로도
 * 안 지워진다). 여기서는 항목을 즉시 제거하고, **같은 세션을 공유하던 다른 뷰어에게도
 * 통지해** 각자가 재진입하도록 한다.
 */
export function dropCollabSession(path: string, session: YCollabSession): void {
  const entry = registry.get(path)
  if (!entry || entry.session !== session) return
  // M11 계측: 명시적 drop(4001 등).
  tl('session.drop', { path, clientId: session.clientId, stack: tlStack(3) })
  registry.delete(path)
  entry.dead = true
  const listeners = [...entry.notifyReset]
  entry.notifyReset.clear()
  session.destroy()
  for (const fn of listeners) {
    try {
      fn('dropped')
    } catch {
      // 통지 실패는 정리 흐름을 막지 않는다.
    }
  }
}

/** 디버그/테스트용: 현재 유지 중인 세션 수. */
export function collabSessionCount(): number {
  return registry.size
}

/** 디버그/테스트용: 특정 경로의 참조 수(-1이면 항목 없음). */
export function collabSessionRefs(path: string): number {
  return registry.get(path)?.refs ?? -1
}