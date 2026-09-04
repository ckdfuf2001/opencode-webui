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

export function sendPushNotification(title: string, opts?: NotificationOptions): void {
  try {
    if (!isPushSupported()) return
    if (Notification.permission !== 'granted') return
    const n = new Notification(title, {
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      ...opts,
    })
    n.onclick = () => {
      window.focus()
      n.close()
    }
    setTimeout(() => n.close(), 6000)
  } catch {}
}

// per-session overrides stored in localStorage
const OVERRIDES_KEY = 'opencode-session-notify-overrides'

type SessionOverride = { soundEnabled?: boolean; pushEnabled?: boolean }
type OverridesMap = Record<string, SessionOverride>

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

export function getSessionOverride(sessionId: string): SessionOverride {
  return readOverrides()[sessionId] ?? {}
}

export function setSessionOverride(sessionId: string, patch: SessionOverride): void {
  const map = readOverrides()
  const cur = map[sessionId] ?? {}
  const next = { ...cur, ...patch }
  // if both undefined, remove entry to keep storage clean
  if (next.soundEnabled === undefined && next.pushEnabled === undefined) {
    delete map[sessionId]
  } else {
    map[sessionId] = next
  }
  writeOverrides(map)
  // dispatch event so other hooks can react
  window.dispatchEvent(new CustomEvent('opencode:session-notify-changed', { detail: { sessionId, patch } }))
}

export function shouldPlaySound(sessionId: string | undefined, isCancel: boolean, prefs: { completionSoundEnabled?: boolean; completionSoundOnCancel?: boolean }): boolean {
  if (prefs.completionSoundEnabled === false) return false
  if (isCancel && prefs.completionSoundOnCancel === false) return false
  if (!sessionId) return true
  const ov = getSessionOverride(sessionId)
  if (ov.soundEnabled === false) return false
  return true
}

export function shouldPush(sessionId: string | undefined, prefs: { pushNotificationEnabled?: boolean }): boolean {
  if (prefs.pushNotificationEnabled !== true) return false
  if (!sessionId) return true
  const ov = getSessionOverride(sessionId)
  if (ov.pushEnabled === false) return false
  return true
}
