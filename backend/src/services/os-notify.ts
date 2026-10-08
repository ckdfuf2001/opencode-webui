import { spawnSync } from 'node:child_process'
import { logger } from '../utils/logger'

/**
 * Windows OS 토스트 (무의존 — PowerShell WinRT ToastNotificationManager).
 * 프론트(브라우저)가 꺼져 있어도 백단이 직접 PC에 알린다.
 * 등록된 AppId가 없어 Action Center 보관·클릭 이동은 안 되고 팝업 표시만 된다 (v1).
 */
export function showOsToast(title: string, body: string, opts?: { expireSeconds?: number }): boolean {
  if (process.platform !== 'win32') {
    logger.debug('OS toast skipped (non-Windows)')
    return false
  }
  try {
    const script = buildToastScript(title, body, opts?.expireSeconds)
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

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

function buildToastScript(title: string, body: string, expireSeconds?: number): string {
  const t = (title || '').slice(0, 200)
  const b = (body || '').slice(0, 400)
  const expire =
    typeof expireSeconds === 'number' && expireSeconds > 0
      ? `$toast.ExpirationTime = [DateTimeOffset]::Now.AddSeconds(${Math.min(3600, Math.max(5, Math.floor(expireSeconds)))})`
      : ''
  return [
    `$ErrorActionPreference = 'Stop'`,
    `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null`,
    `$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)`,
    `$texts = $xml.GetElementsByTagName("text")`,
    `$texts.Item(0).AppendChild($xml.CreateTextNode(${psQuote(t)})) > $null`,
    `$texts.Item(1).AppendChild($xml.CreateTextNode(${psQuote(b)})) > $null`,
    `$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)`,
    expire,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("opencode-webui").Show($toast)`,
  ]
    .filter(Boolean)
    .join('\r\n')
}
