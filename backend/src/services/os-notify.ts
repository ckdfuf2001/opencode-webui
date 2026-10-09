import { spawnSync } from 'node:child_process'
import { logger } from '../utils/logger'
import { getWebuiBaseUrl } from './webui-base'

/**
 * Windows OS 토스트 (무의존 — PowerShell WinRT ToastNotificationManager).
 * 프론트(브라우저)가 꺼져 있어도 백단이 직접 PC에 알린다.
 *
 * 클릭 이동: launch에 http(s) URL을 그대로 넣어 OS가 기본 브라우저로 연다
 * (유튜브 웹 알림과 같은 방식 — 별도 스크립트/프로토콜 등록 없음).
 */

const APP_ID = 'opencode-webui'

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
    const url = opts?.path ? `${getWebuiBaseUrl()}${opts.path}` : undefined
    const script = buildToastScript(title, body, opts?.expireSeconds, url)
    // UTF-16LE base64로 넘겨 따옴표/한글 깨짐을 피한다.
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      timeout: 15_000,
      windowsHide: true,
    })
    if (res.status !== 0) {
      const detail = [
        `status=${res.status}`,
        res.signal ? `signal=${res.signal}` : '',
        res.error ? `error=${res.error instanceof Error ? res.error.message : res.error}` : '',
        res.stderr ? `stderr=${res.stderr.toString().trim().slice(0, 300)}` : '',
      ]
        .filter(Boolean)
        .join(' ')
      logger.warn(`OS toast failed: ${detail}`)
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
  // launch가 http(s)면 OS가 기본 브라우저로 직접 연다.
  const launchAttr = url ? ` launch="${escapeXml(url)}"` : ''
  const loadXml =
    `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument; ` +
    `$xml.LoadXml(${psSingleQuote(
      `<toast${launchAttr} duration="${long ? 'long' : 'short'}"><visual><binding template="ToastGeneric"><text>${t}</text><text>${b}</text></binding></visual></toast>`,
    )})`
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
