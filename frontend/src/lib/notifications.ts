export function isPushSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
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

export async function sendPushNotification(title: string, opts?: NotificationOptions): Promise<void> {
  try {
    if (!isPushSupported()) return
    if (Notification.permission !== 'granted') return
    const baseOpts: NotificationOptions & { renotify?: boolean } = {
      badge: '/favicon.svg',
      icon: '/favicon.svg',
      requireInteraction: false,
      silent: false,
      ...opts,
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
          return
        }
      } catch {}
      // SW가 없으면 최소 SW를 동적으로 등록해 OS 알림 시도
      try {
        const swCode = `self.addEventListener('notificationclick', function(e){e.notification.close(); e.waitUntil(clients.matchAll({type:'window'}).then(function(cs){ if(cs.length>0) return cs[0].focus(); return clients.openWindow('/'); }));}); self.addEventListener('push', function(e){});`
        const blob = new Blob([swCode], { type: 'text/javascript' })
        const url = URL.createObjectURL(blob)
        const reg = await navigator.serviceWorker.register(url, { scope: '/' })
        await navigator.serviceWorker.ready
        await reg.showNotification(title, baseOpts)
        return
      } catch {}
    }
    const n = new Notification(title, baseOpts as NotificationOptions)
    n.onclick = () => {
      try { window.focus() } catch {}
      n.close()
    }
    setTimeout(() => { try { n.close() } catch {} }, 7000)
  } catch {}
}

export function triggerTestPush(): void {
  void sendPushNotification('테스트 알림', { body: 'PC 푸시 알림이 정상적으로 동작합니다.', tag: 'test-push' } as NotificationOptions)
}

export function getNotificationSettingsUrl(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (ua.includes('Edg')) return 'edge://settings/privacy/sitePermissions/allPermissions/popups'
  if (ua.includes('Chrome') && !ua.includes('Edg')) return 'chrome://settings/content/notifications'
  if (ua.includes('Firefox')) return 'about:preferences#privacy'
  if (ua.includes('Safari') && !ua.includes('Chrome')) return ''
  return ''
}

export function getNotificationSettingsHelp(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (ua.includes('Edg')) return 'Edge: edge://settings/privacy/sitePermissions/allPermissions/popups 또는 주소창 자물쇠 → 사이트 권한 → 알림'
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

// per-session overrides stored in localStorage
const OVERRIDES_KEY = 'opencode-session-notify-overrides'
const REPO_OVERRIDES_KEY = 'opencode-repo-notify-overrides'
const SESSION_PERM_KEY = 'opencode-session-permission-rules'

type SessionOverride = { soundEnabled?: boolean; pushEnabled?: boolean; skillAutoEnabled?: boolean }
type RepoOverride = { soundEnabled?: boolean; pushEnabled?: boolean; skillAutoEnabled?: boolean }
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

function writeOverrides(map: OverridesMap): void {
  try {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(map))
  } catch {}
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

function writeRepoOverrides(map: RepoOverridesMap): void {
  try {
    localStorage.setItem(REPO_OVERRIDES_KEY, JSON.stringify(map))
  } catch {}
}

export function getSessionOverride(sessionId: string): SessionOverride {
  return readOverrides()[sessionId] ?? {}
}

export function setSessionOverride(sessionId: string, patch: SessionOverride): void {
  const map = readOverrides()
  const cur = map[sessionId] ?? {}
  const next = { ...cur, ...patch }
  if (next.soundEnabled === undefined && next.pushEnabled === undefined && next.skillAutoEnabled === undefined) {
    delete map[sessionId]
  } else {
    map[sessionId] = next
  }
  writeOverrides(map)
  window.dispatchEvent(new CustomEvent('opencode:session-notify-changed', { detail: { sessionId, patch } }))
}

export function getRepoOverride(repoId: number | string): RepoOverride {
  return readRepoOverrides()[String(repoId)] ?? {}
}

export function setRepoOverride(repoId: number | string, patch: RepoOverride): void {
  const map = readRepoOverrides()
  const cur = map[String(repoId)] ?? {}
  const next = { ...cur, ...patch }
  if (next.soundEnabled === undefined && next.pushEnabled === undefined && next.skillAutoEnabled === undefined) {
    delete map[String(repoId)]
  } else {
    map[String(repoId)] = next
  }
  writeRepoOverrides(map)
  window.dispatchEvent(new CustomEvent('opencode:repo-notify-changed', { detail: { repoId, patch } }))
}

// 세션별 permission rule (로컬)
export interface SessionPermissionRule { id: string; permission: string; pattern: string; createdAt: number }
export function getSessionPermissionRules(sessionId: string): SessionPermissionRule[] {
  try {
    const raw = localStorage.getItem(SESSION_PERM_KEY)
    const map = raw ? JSON.parse(raw) as Record<string, SessionPermissionRule[]> : {}
    return map[sessionId] ?? []
  } catch { return [] }
}
export function addSessionPermissionRule(sessionId: string, rule: Omit<SessionPermissionRule, 'id' | 'createdAt'>): SessionPermissionRule {
  const map = (() => { try { const r = localStorage.getItem(SESSION_PERM_KEY); return r ? JSON.parse(r) as Record<string, SessionPermissionRule[]> : {} } catch { return {} } })()
  const list = map[sessionId] ?? []
  const created: SessionPermissionRule = { id: `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`, createdAt: Date.now(), ...rule }
  list.push(created)
  map[sessionId] = list
  try { localStorage.setItem(SESSION_PERM_KEY, JSON.stringify(map)) } catch {}
  window.dispatchEvent(new CustomEvent('opencode:session-perm-changed', { detail: { sessionId } }))
  return created
}
export function deleteSessionPermissionRule(sessionId: string, ruleId: string): void {
  try {
    const raw = localStorage.getItem(SESSION_PERM_KEY)
    const map = raw ? JSON.parse(raw) as Record<string, SessionPermissionRule[]> : {}
    const list = (map[sessionId] ?? []).filter(r => r.id !== ruleId)
    if (list.length === 0) delete map[sessionId]
    else map[sessionId] = list
    localStorage.setItem(SESSION_PERM_KEY, JSON.stringify(map))
    window.dispatchEvent(new CustomEvent('opencode:session-perm-changed', { detail: { sessionId } }))
  } catch {}
}

export function shouldPlaySound(sessionId: string | undefined, isCancel: boolean, prefs: { completionSoundEnabled?: boolean; completionSoundOnCancel?: boolean }, repoId?: number | string): boolean {
  if (isCancel && prefs.completionSoundOnCancel === false) return false
  // 세션 > 레포 > 전역 순으로 우선순위
  if (sessionId) {
    const ov = getSessionOverride(sessionId)
    if (ov.soundEnabled === true) return true
    if (ov.soundEnabled === false) return false
  }
  if (repoId !== undefined && repoId !== null) {
    const rov = getRepoOverride(repoId)
    if (rov.soundEnabled === true) return true
    if (rov.soundEnabled === false) return false
  }
  if (prefs.completionSoundEnabled === false) return false
  return true
}

export function shouldPush(sessionId: string | undefined, prefs: { pushNotificationEnabled?: boolean }, repoId?: number | string): boolean {
  if (sessionId) {
    const ov = getSessionOverride(sessionId)
    if (ov.pushEnabled === true) return true
    if (ov.pushEnabled === false) return false
  }
  if (repoId !== undefined && repoId !== null) {
    const rov = getRepoOverride(repoId)
    if (rov.pushEnabled === true) return true
    if (rov.pushEnabled === false) return false
  }
  return prefs.pushNotificationEnabled === true
}

export function getEffectiveSound(repoId: number | string | undefined, sessionId: string | undefined, prefs: { completionSoundEnabled?: boolean }): { global: boolean; repo?: boolean; session?: boolean; effective: boolean } {
  const global = prefs.completionSoundEnabled !== false
  const repo = repoId !== undefined ? getRepoOverride(repoId).soundEnabled : undefined
  const session = sessionId ? getSessionOverride(sessionId).soundEnabled : undefined
  let effective = global
  if (repo !== undefined) effective = repo
  if (session !== undefined) effective = session
  return { global, repo, session, effective }
}
export function getEffectivePush(repoId: number | string | undefined, sessionId: string | undefined, prefs: { pushNotificationEnabled?: boolean }): { global: boolean; repo?: boolean; session?: boolean; effective: boolean } {
  const global = prefs.pushNotificationEnabled === true
  const repo = repoId !== undefined ? getRepoOverride(repoId).pushEnabled : undefined
  const session = sessionId ? getSessionOverride(sessionId).pushEnabled : undefined
  let effective = global
  if (repo !== undefined) effective = repo
  if (session !== undefined) effective = session
  return { global, repo, session, effective }
}
export function getEffectiveSkillAuto(repoId: number | string | undefined, sessionId: string | undefined, repoSkillAuto: boolean | undefined): { repo: boolean; session?: boolean; effective: boolean } {
  const repo = repoSkillAuto ?? false
  const repoOv = repoId !== undefined ? getRepoOverride(repoId).skillAutoEnabled : undefined
  const sessOv = sessionId ? getSessionOverride(sessionId).skillAutoEnabled : undefined
  let effective = repoOv !== undefined ? repoOv : repo
  if (sessOv !== undefined) effective = sessOv
  return { repo, session: sessOv, effective }
}
