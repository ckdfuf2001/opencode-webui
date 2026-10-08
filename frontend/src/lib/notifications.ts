// OS 토스트는 백단이 직접 발송한다 (프론트 꺼짐 대응).
// 프론트는 완료 틱 소리만 담당하고, 설정값은 백단 API가 단일 진실 통로다.
// localStorage에는 마이그레이션 전 레거시 값만 남는다 (폴백 읽기용).

// per-session overrides stored in localStorage
const OVERRIDES_KEY = 'opencode-session-notify-overrides'
const REPO_OVERRIDES_KEY = 'opencode-repo-notify-overrides'
const SESSION_PERM_KEY = 'opencode-session-permission-rules'

type SessionOverride = { soundEnabled?: boolean; soundOnCancelEnabled?: boolean; pushEnabled?: boolean; skillAutoEnabled?: boolean; skillReviewEnabled?: boolean }
type RepoOverride = { soundEnabled?: boolean; soundOnCancelEnabled?: boolean; pushEnabled?: boolean; skillAutoEnabled?: boolean; skillReviewEnabled?: boolean }
type OverridesMap = Record<string, SessionOverride>
type RepoOverridesMap = Record<string, RepoOverride>

function readOverrides(): OverridesMap {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as OverridesMap
  } catch {
    return {}
  }
}

function readRepoOverrides(): RepoOverridesMap {
  try {
    const raw = localStorage.getItem(REPO_OVERRIDES_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as RepoOverridesMap
  } catch {
    return {}
  }
}

export function getSessionOverride(sessionId: string): SessionOverride {
  return readOverrides()[sessionId] ?? {}
}

export function getRepoOverride(repoId: number | string): RepoOverride {
  return readRepoOverrides()[String(repoId)] ?? {}
}

/** 오버라이드 읽기 소스 — 기본은 백단 API 캐시, 비어 있으면 레거시 localStorage 폴백. */
export interface OverrideSource {
  session: (sessionId: string) => SessionOverride
  repo: (repoId: number | string) => RepoOverride
}

export const legacyOverrideSource: OverrideSource = {
  session: (sessionId: string) => getSessionOverride(sessionId),
  repo: (repoId: number | string) => getRepoOverride(repoId),
}

/** 마이그레이션용 레거시 전체 읽기. */
export function readLegacySessionOverrides(): OverridesMap {
  return readOverrides()
}

export function readLegacyRepoOverrides(): RepoOverridesMap {
  return readRepoOverrides()
}

export function clearLegacyNotifyOverrides(): void {
  try {
    localStorage.removeItem(OVERRIDES_KEY)
    localStorage.removeItem(REPO_OVERRIDES_KEY)
  } catch {}
}

// 세션 permission rule 마이그레이션용 레거시 읽기 (룰 자체는 백단 소유).
export interface LegacySessionPermissionRule { id: string; permission: string; pattern: string; createdAt: number }
export function readAllLegacySessionPermissionRules(): Record<string, LegacySessionPermissionRule[]> {
  try {
    const raw = localStorage.getItem(SESSION_PERM_KEY)
    return raw ? JSON.parse(raw) as Record<string, LegacySessionPermissionRule[]> : {}
  } catch { return {} }
}
export function clearLegacySessionPermissionRules(): void {
  try {
    localStorage.removeItem(SESSION_PERM_KEY)
  } catch {}
}

export function shouldPlaySound(sessionId: string | undefined, isCancel: boolean, prefs: { completionSoundEnabled?: boolean; completionSoundOnCancel?: boolean }, repoId?: number | string, source: OverrideSource = legacyOverrideSource): boolean {
  if (isCancel) {
    // 세션 > 레포 > 전역 순으로 취소음 우선순위
    if (sessionId) {
      const ov = source.session(sessionId)
      if (ov.soundOnCancelEnabled === true) { /* fall through to sound check */ }
      else if (ov.soundOnCancelEnabled === false) return false
      else {
        if (repoId !== undefined && repoId !== null) {
          const rov = source.repo(repoId)
          if (rov.soundOnCancelEnabled === true) { /* fall through */ }
          else if (rov.soundOnCancelEnabled === false) return false
          else if (prefs.completionSoundOnCancel === false) return false
        } else if (prefs.completionSoundOnCancel === false) return false
      }
    } else if (repoId !== undefined && repoId !== null) {
      const rov = source.repo(repoId)
      if (rov.soundOnCancelEnabled === false) return false
      if (rov.soundOnCancelEnabled === undefined && prefs.completionSoundOnCancel === false) return false
    } else if (prefs.completionSoundOnCancel === false) return false
  }
  // 세션 > 레포 > 전역 순으로 우선순위
  if (sessionId) {
    const ov = source.session(sessionId)
    if (ov.soundEnabled === true) return true
    if (ov.soundEnabled === false) return false
  }
  if (repoId !== undefined && repoId !== null) {
    const rov = source.repo(repoId)
    if (rov.soundEnabled === true) return true
    if (rov.soundEnabled === false) return false
  }
  if (prefs.completionSoundEnabled === false) return false
  return true
}

export function shouldPush(sessionId: string | undefined, prefs: { pushNotificationEnabled?: boolean }, repoId?: number | string, source: OverrideSource = legacyOverrideSource): boolean {
  if (sessionId) {
    const ov = source.session(sessionId)
    if (ov.pushEnabled === true) return true
    if (ov.pushEnabled === false) return false
  }
  if (repoId !== undefined && repoId !== null) {
    const rov = source.repo(repoId)
    if (rov.pushEnabled === true) return true
    if (rov.pushEnabled === false) return false
  }
  return prefs.pushNotificationEnabled === true
}

export function getEffectiveSound(repoId: number | string | undefined, sessionId: string | undefined, prefs: { completionSoundEnabled?: boolean }, source: OverrideSource = legacyOverrideSource): { global: boolean; repo?: boolean; session?: boolean; effective: boolean } {
  const global = prefs.completionSoundEnabled !== false
  const repo = repoId !== undefined ? source.repo(repoId).soundEnabled : undefined
  const session = sessionId ? source.session(sessionId).soundEnabled : undefined
  let effective = global
  if (repo !== undefined) effective = repo
  if (session !== undefined) effective = session
  return { global, repo, session, effective }
}
export function getEffectiveSoundOnCancel(repoId: number | string | undefined, sessionId: string | undefined, prefs: { completionSoundOnCancel?: boolean }, source: OverrideSource = legacyOverrideSource): { global: boolean; repo?: boolean; session?: boolean; effective: boolean } {
  const global = prefs.completionSoundOnCancel !== false
  const repo = repoId !== undefined ? source.repo(repoId).soundOnCancelEnabled : undefined
  const session = sessionId ? source.session(sessionId).soundOnCancelEnabled : undefined
  let effective = global
  if (repo !== undefined) effective = repo
  if (session !== undefined) effective = session
  return { global, repo, session, effective }
}
export function getEffectivePush(repoId: number | string | undefined, sessionId: string | undefined, prefs: { pushNotificationEnabled?: boolean }, source: OverrideSource = legacyOverrideSource): { global: boolean; repo?: boolean; session?: boolean; effective: boolean } {
  const global = prefs.pushNotificationEnabled === true
  const repo = repoId !== undefined ? source.repo(repoId).pushEnabled : undefined
  const session = sessionId ? source.session(sessionId).pushEnabled : undefined
  let effective = global
  if (repo !== undefined) effective = repo
  if (session !== undefined) effective = session
  return { global, repo, session, effective }
}
export function getEffectiveSkillAuto(repoId: number | string | undefined, sessionId: string | undefined, repoSkillAuto: boolean | undefined, source: OverrideSource = legacyOverrideSource): { repo: boolean; session?: boolean; effective: boolean } {
  const repo = repoSkillAuto ?? false
  const repoOv = repoId !== undefined ? source.repo(repoId).skillAutoEnabled : undefined
  const sessOv = sessionId ? source.session(sessionId).skillAutoEnabled : undefined
  let effective = repoOv !== undefined ? repoOv : repo
  if (sessOv !== undefined) effective = sessOv
  return { repo, session: sessOv, effective }
}
export function getEffectiveSkillReview(repoId: number | string | undefined, sessionId: string | undefined, repoSkillReview: boolean | undefined, source: OverrideSource = legacyOverrideSource): { repo: boolean; session?: boolean; effective: boolean } {
  const repo = repoSkillReview ?? false
  const repoOv = repoId !== undefined ? source.repo(repoId).skillReviewEnabled : undefined
  const sessOv = sessionId ? source.session(sessionId).skillReviewEnabled : undefined
  let effective = repoOv !== undefined ? repoOv : repo
  if (sessOv !== undefined) effective = sessOv
  return { repo, session: sessOv, effective }
}
export function clearSessionNotifyData(sessionId: string): void {
  // 백단 오버라이드 + 세션 룰 삭제 (fire-and-forget) + 로컬 permission rule 정리.
  try {
    void import('@/api/notify').then((m) => m.clearNotifyOverride('session', sessionId).catch(() => {}))
  } catch {}
  try {
    void import('@/api/permission-rules').then((m) => m.deleteSessionPermissionRulesBySession(sessionId).catch(() => {}))
  } catch {}
  try {
    const raw = localStorage.getItem(SESSION_PERM_KEY)
    if (raw) {
      const m = JSON.parse(raw) as Record<string, unknown>
      if (m[sessionId]) { delete m[sessionId]; localStorage.setItem(SESSION_PERM_KEY, JSON.stringify(m)) }
    }
  } catch {}
  try { window.dispatchEvent(new CustomEvent('opencode:session-perm-changed', { detail: { sessionId } })) } catch {}
}
export function clearRepoNotifyData(repoId: number | string): void {
  try {
    void import('@/api/notify').then((m) => m.clearNotifyOverride('repo', String(repoId)).catch(() => {}))
  } catch {}
}
export function cloneRepoNotifyData(sourceRepoId: number | string, targetRepoId: number | string): void {
  // 백단에서 복사 (fire-and-forget).
  try {
    void import('@/api/notify').then(async (m) => {
      try {
        const list = await m.listNotifyOverrides()
        const src = list.find((o) => o.scope === 'repo' && o.target === String(sourceRepoId))
        if (!src) return
        const { scope: _s, target: _t, updatedAt: _u, ...patch } = src
        await m.setNotifyOverride('repo', String(targetRepoId), patch).catch(() => {})
      } catch {}
    })
  } catch {}
}
