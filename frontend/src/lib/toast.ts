import { toast } from 'sonner'
import { API_BASE_URL } from '@/config'

interface ToastOptions {
  duration?: number
  description?: string
  action?: {
    label: string
    onClick: () => void
  }
  id?: string | number
}

/** 토스트 오류가 기록되는 파일(logs/frontend-YYYY-MM.log). 백엔드 POST /api/logs 와 동일 규칙. */
export function clientLogFileHint(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `logs/frontend-${d.getFullYear()}-${mm}.log`
}

/** opencode 자체 로그. 프록시가 채워주지 못한 사유는 여기서 확인한다. */
export const OPENCODE_LOG_HINT = '~/.local/share/opencode/log/opencode.log'

// 같은 오류로 짧은 시간에 여러 토스트가 뜨면 로그도 중복 적재된다.
const recentLogs = new Map<string, number>()
const LOG_DEDUPE_MS = 1500

function logToast(level: 'error' | 'warn', message: string, options?: ToastOptions): void {
  const key = `${level}:${message}`
  const now = Date.now()
  const last = recentLogs.get(key) ?? 0
  if (now - last < LOG_DEDUPE_MS) return
  recentLogs.set(key, now)
  if (recentLogs.size > 100) recentLogs.clear()

  try {
    void fetch(`${API_BASE_URL}/api/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level,
        message,
        detail: options?.description,
        href: window.location.href,
      }),
      keepalive: true,
    }).catch(() => undefined)
  } catch {
    // 로깅 실패가 토스트 동작을 해치지 않는다
  }
}

function withFileHint(message: string): string {
  if (message.includes('See logs')) return message
  // 메시지(사유)는 그대로 보여주고, 로그 위치 안내는 description 으로 뺀다
  return message
}

function logsDescription(options?: ToastOptions): string {
  const own = options?.description ? `${options.description} · ` : ''
  return `${own}See logs: ${clientLogFileHint()}, ${OPENCODE_LOG_HINT}`
}

export const showToast = {
  success: (message: string, options?: ToastOptions) => {
    return toast.success(message, options)
  },

  error: (message: string, options?: ToastOptions) => {
    logToast('error', message, options)
    return toast.error(withFileHint(message), { ...options, description: logsDescription(options) })
  },

  info: (message: string, options?: ToastOptions) => {
    return toast.info(message, options)
  },

  warning: (message: string, options?: ToastOptions) => {
    logToast('warn', message, options)
    return toast.warning(withFileHint(message), { ...options, description: logsDescription(options) })
  },

  loading: (message: string, options?: ToastOptions) => {
    return toast.loading(message, options)
  },

  dismiss: (id?: string | number) => {
    toast.dismiss(id)
  }
}

export type ShowToast = typeof showToast
