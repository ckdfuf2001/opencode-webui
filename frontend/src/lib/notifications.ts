// OS 토스트는 프론트(브라우저 Notification API)가 발송한다.
// 설정값(오버라이드)은 백단 API가 단일 진실 통로, 소리/푸시 판정만 여기서 한다.
// localStorage에는 마이그레이션 전 레거시 값만 남는다 (폴백 읽기용).

// per-session overrides stored in localStorage
const OVERRIDES_KEY = 'opencode-session-notify-overrides'
const REPO_OVERRIDES_KEY = 'opencode-repo-notify-overrides'
const SESSION_PERM_KEY = 'opencode-session-permission-rules'

export type SessionOverride = { soundEnabled?: boolean; soundOnCancelEnabled?: boolean; pushEnabled?: boolean; skillAutoEnabled?: boolean; skillReviewEnabled?: boolean }
export type RepoOverride = { soundEnabled?: boolean; soundOnCancelEnabled?: boolean; pushEnabled?: boolean; skillAutoEnabled?: boolean; skillReviewEnabled?: boolean }
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

// OS 토스트 표시 (브라우저 Notification API — 프론트가 발송 주체).
export function isPushSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window && window.isSecureContext
}

export async function ensurePushPermission(): Promise<NotificationPermission | null> {
  if (!isPushSupported()) return null
  if (Notification.permission === 'granted') return 'granted'
  if (Notification.permission === 'denied') return 'denied'
  try {
    const perm = await Notification.requestPermission()
    return perm
  } catch {
    return null
  }
}

export async function sendPushNotification(title: string, opts?: NotificationOptions, url?: string, durationSec?: number): Promise<void> {
  try {
    if (!isPushSupported()) return
    if (Notification.permission !== 'granted') return
    const duration = typeof durationSec === 'number' ? durationSec : (() => { try { const raw = localStorage.getItem('opencode-push-duration'); if (raw != null) { const n = parseInt(raw, 10); if (!Number.isNaN(n) && n >= 0) return n; } } catch {} return 0 })()
    const requireInteraction = duration === 0
    const baseOpts: NotificationOptions & { renotify?: boolean } = {
      badge: '/favicon.svg',
      icon: '/favicon.svg',
      requireInteraction,
      silent: false,
      // 같은 tag(sessionId) 교체 시 조용히 바뀌어 취소 알림이 안 온 것처럼 보임 → 항상 재알림
      renotify: true,
      ...opts,
      data: { ...((opts as unknown as { data?: Record<string, unknown> } | undefined)?.data ?? {}), ...(url ? { url } : {}) },
    }
    // 유튜브 등도 ServiceWorker showNotification을 사용 — 백그라운드/다른 탭에서도 OS 알림이 뜨도록
    if ('serviceWorker' in navigator) {
      try {
        // 이미 등록된 SW가 있으면 그대로 사용
        const ready = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise<null>((res) => setTimeout(() => res(null), 400)),
        ])
        if (ready) {
          await (ready as ServiceWorkerRegistration).showNotification(title, baseOpts)
          if (duration > 0) {
            setTimeout(async () => {
              try {
                const notifs = await (ready as ServiceWorkerRegistration).getNotifications({ tag: (opts as unknown as { tag?: string })?.tag ?? undefined } as never)
                notifs.forEach((nn) => { try { nn.close() } catch {} })
              } catch {}
            }, duration * 1000)
          }
          return
        }
      } catch {}
      // SW가 없으면 최소 SW를 동적으로 등록해 OS 알림 시도
      try {
        const swCode = `self.addEventListener('notificationclick', function(e){e.notification.close(); var url=(e.notification.data&&e.notification.data.url)||'/'; var target=url; try{target=new URL(url,self.registration.scope).href;}catch(_){} e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(function(cs){ for(var i=0;i<cs.length;i++){ try{ if(cs[i].url&&cs[i].url.indexOf(target)!==-1) return cs[i].focus(); }catch(_){} } if(cs.length>0){ var c=cs[0]; try{ if(c.navigate) return c.navigate(target).then(function(cc){return cc.focus();}); }catch(_){} return c.focus(); } return clients.openWindow(target); }));}); self.addEventListener('push', function(e){});`
        const blob = new Blob([swCode], { type: 'text/javascript' })
        const url = URL.createObjectURL(blob)
        const reg = await navigator.serviceWorker.register(url, { scope: '/' })
        await navigator.serviceWorker.ready
        await reg.showNotification(title, baseOpts)
        if (duration > 0) {
          setTimeout(async () => {
            try {
              const notifs = await reg.getNotifications({ tag: (opts as unknown as { tag?: string })?.tag ?? undefined } as never)
              notifs.forEach((nn) => { try { nn.close() } catch {} })
            } catch {}
          }, duration * 1000)
        }
        return
      } catch {}
    }
    const n = new Notification(title, baseOpts as NotificationOptions)
    n.onclick = () => {
      try {
        window.focus()
        if (url) window.location.href = url
      } catch {}
      n.close()
    }
    if (duration > 0) {
      setTimeout(() => { try { n.close() } catch {} }, duration * 1000)
    }
  } catch {}
}

export function triggerTestPush(): void {
  void sendPushNotification('테스트 알림', { body: 'PC 푸시 알림이 정상적으로 동작합니다.', tag: 'test-push' } as NotificationOptions)
}

export function getNotificationSettingsUrl(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (ua.includes('Edg')) return 'edge://settings/privacy/sitePermissions/allPermissions/notifications'
  if (ua.includes('Chrome') && !ua.includes('Edg')) return 'chrome://settings/content/notifications'
  if (ua.includes('Firefox')) return 'about:preferences#privacy'
  if (ua.includes('Safari') && !ua.includes('Chrome')) return ''
  return ''
}

export function getNotificationSettingsHelp(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (ua.includes('Edg')) return 'Edge: edge://settings/privacy/sitePermissions/allPermissions/notifications 또는 주소창 자물쇠 → 사이트 권한 → 알림'
  if (ua.includes('Chrome') && !ua.includes('Edg')) return 'Chrome: chrome://settings/content/notifications 또는 주소창 자물쇠 → 사이트 설정 → 알림'
  if (ua.includes('Firefox')) return 'Firefox: about:preferences#privacy → 권한 → 알림 → 설정'
  if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari: 설정 → 웹사이트 → 알림'
  return '브라우저 주소창 자물쇠 → 사이트 설정 → 알림'
}

export function openNotificationSettings(): boolean {
  const url = getNotificationSettingsUrl()
  if (!url) return false
  // edge:// / chrome://는 웹에서 직접 열면 about:blank#blocked로 차단됨 — 새탭에 안내 페이지를 열어 값을 넣어줌
  if (url.startsWith('edge://') || url.startsWith('chrome://')) {
    try { void navigator.clipboard?.writeText(url) } catch {}
    try {
      const w = window.open('about:blank', '_blank')
      if (w) {
        const esc = url.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>알림 설정</title><style>body{font-family:system-ui;padding:32px;max-width:640px;margin:40px auto;line-height:1.6}code{background:#f1f5f9;padding:6px 10px;border-radius:6px;word-break:break-all;display:block;margin:12px 0;font-size:14px}button{margin-top:12px;padding:8px 16px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer}button:hover{background:#1d4ed8}.muted{color:#64748b;font-size:13px;margin-top:16px}</style></head><body><h2>브라우저 알림 설정</h2><p>아래 주소를 <b>클립보드에 복사</b>했습니다. 새탭을 열고 주소창에 <b>붙여넣기(Ctrl+V)</b> 후 Enter로 이동하세요.</p><code id="u">${esc}</code><button onclick="navigator.clipboard.writeText(document.getElementById('u').textContent).then(()=>{this.textContent='복사됨!'; setTimeout(()=>this.textContent='복사',1500)})">복사</button><p class="muted">또는 주소창 왼쪽 자물쇠 → 사이트 권한 → 알림 에서 허용으로 변경</p><p class="muted">브라우저 보안상 웹에서 edge://를 직접 열 수 없어 새탭에 값을 넣어드렸습니다.</p></body></html>`
        w.document.open()
        w.document.write(html)
        w.document.close()
        try { w.focus() } catch {}
        return true
      }
    } catch {}
    return false
  }
  try {
    const w = window.open(url, '_blank')
    if (!w || w.closed) return false
    return true
  } catch {
    return false
  }
}
