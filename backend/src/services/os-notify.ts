import { spawnSync } from 'node:child_process'
import { logger } from '../utils/logger'
import { getWebuiBaseUrl } from './webui-base'

/**
 * Windows OS 토스트 (무의존 — PowerShell WinRT ToastNotificationManager).
 * 프론트(브라우저)가 꺼져 있어도 백단이 직접 PC에 알린다.
 *
 * 클릭 이동: `opencode-webui://` 프로토콜을 HKCU에 등록하고
 * 토스트 launch에 세션 URL을 실어 기본 브라우저 새 창으로 연다.
 */

const APP_ID = 'opencode-webui'
const PROTOCOL = 'opencode-webui'

export function showOsToast(
  title: string,
  body: string,
  opts?: { expireSeconds?: number; path?: string },
): boolean {
  if (process.platform !== 'win32') {
    logger.debug('OS toast skipped (non-Windows)')
    return false
  }
  try {
    ensureToastActivation()
    const url = opts?.path ? `${getWebuiBaseUrl()}${opts.path}` : undefined
    const script = buildToastScript(title, body, opts?.expireSeconds, url)
    // UTF-16LE base64로 넘겨 따옴표/한글 깨짐을 피한다.
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      timeout: 15_000,
      windowsHide: true,
    })
    if (res.status !== 0) {
      logger.warn(`OS toast failed: ${res.stderr?.toString().trim().slice(0, 300) ?? res.error}`)
      return false
    }
    return true
  } catch (error) {
    logger.warn(`OS toast error: ${error instanceof Error ? error.message : error}`)
    return false
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function psSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

function buildToastScript(title: string, body: string, expireSeconds?: number, url?: string): string {
  const t = escapeXml((title || '').slice(0, 200))
  const b = escapeXml((body || '').slice(0, 400))
  const long = !(typeof expireSeconds === 'number' && expireSeconds > 0)
  const expire = long
    ? ''
    : `$toast.ExpirationTime = [DateTimeOffset]::Now.AddSeconds(${Math.min(3600, Math.max(5, Math.floor(expireSeconds)))})`
  const loadXml = url
    ? `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument; $xml.LoadXml(${psSingleQuote(
        `<toast launch="${PROTOCOL}://open?url=${encodeURIComponent(url)}" activationType="protocol" duration="${long ? 'long' : 'short'}"><visual><binding template="ToastGeneric"><text>${t}</text><text>${b}</text></binding></visual></toast>`,
      )})`
    : [
        `$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)`,
        `$texts = $xml.GetElementsByTagName("text")`,
        `$texts.Item(0).AppendChild($xml.CreateTextNode(${psSingleQuote(title.slice(0, 200))})) > $null`,
        `$texts.Item(1).AppendChild($xml.CreateTextNode(${psSingleQuote(body.slice(0, 400))})) > $null`,
      ].join('\r\n')
  return [
    `$ErrorActionPreference = 'Stop'`,
    `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null`,
    `[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null`,
    loadXml,
    `$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)`,
    expire,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psSingleQuote(APP_ID)}).Show($toast)`,
  ]
    .filter(Boolean)
    .join('\r\n')
}

let activationEnsured = false

/** URL 프로토콜 핸들러 등록. 실패해도 토스트 표시는 계속한다. */
export function ensureToastActivation(): void {
  if (activationEnsured || process.platform !== 'win32') return
  activationEnsured = true
  try {
    ensureProtocolHandler()
  } catch (error) {
    logger.debug(`Toast protocol register skipped: ${error instanceof Error ? error.message : error}`)
  }
}

function regQuery(key: string): string | null {
  try {
    const res = spawnSync('reg.exe', ['query', key, '/ve'], { timeout: 10_000, windowsHide: true, encoding: 'utf8' })
    if (res.status !== 0) return null
    return (res.stdout as string) ?? null
  } catch {
    return null
  }
}

function regAdd(key: string, value: string): boolean {
  const res = spawnSync('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], {
    timeout: 10_000,
    windowsHide: true,
    encoding: 'utf8',
  })
  return res.status === 0
}

/**
 * HKCU URL 프로토콜 등록 — 클릭 시 기본 브라우저로 세션 URL을 연다.
 * 핸들러: %1(opencode-webui://open?url=...)에서 url 파라미터를 꺼내 Start-Process.
 * 핸들러 본문은 exe 경로와 무관하므로 한 번 등록이면 유지된다.
 */
function ensureProtocolHandler(): void {
  const base = `HKCU\\Software\\Classes\\${PROTOCOL}`
  const current = regQuery(`${base}\\shell\\open\\command`)
  if (current && current.includes('Start-Process $u') && current.includes('?url=')) return
  const handler = `powershell.exe -NoProfile -WindowStyle Hidden -Command $a='%1'; $u=[uri]::UnescapeDataString($a.Substring($a.IndexOf('?url=')+5)); Start-Process $u`
  regAdd(base, `URL:${PROTOCOL} OpenCode WebUI`)
  spawnSync('reg.exe', ['add', base, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f'], { timeout: 10_000, windowsHide: true })
  if (regAdd(`${base}\\shell\\open\\command`, handler)) {
    logger.info('Toast protocol handler registered (opencode-webui://)')
  }
}
