import { create } from 'zustand'

/**
 * 레거시 활동 스토어. 상태 표시는 전부 백엔드 DB(session_status) 2초 폴링으로
 * 대체되었고, 이 모듈은 reconciler 가 세션 종료를 로컬에 반영할 때 쓰는
 * markSessionIdle 만 남긴다.
 */
const useLegacyActivityStore = create<{ activeSessions: Record<string, number> }>(() => ({
  activeSessions: {},
}))

export function markSessionIdle(sessionID: string): void {
  useLegacyActivityStore.setState((state) => {
    if (!(sessionID in state.activeSessions)) return state
    const activeSessions = { ...state.activeSessions }
    delete activeSessions[sessionID]
    return { activeSessions }
  })
}
