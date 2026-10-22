import { ENV } from '@opencode-webui/shared'
import { describeError } from './error-detail'

type LogLevel = 'info' | 'warn' | 'error' | 'debug'

export interface BufferedLogLine {
  at: string
  level: LogLevel
  message: string
}

const RING_MAX = 500
const ring: BufferedLogLine[] = []

/**
 * 링 버퍼(GET /api/system/logs)에 남는 인자 문자열.
 *
 * Error 를 그대로 JSON.stringify 하면 DOMException(AbortError/TimeoutError) 처럼
 * 열거 가능한 프로퍼티가 없어 "{}" 로 찍히고 원인이 사라진다(무음 실패).
 * → Error 는 이름·메시지·코드·cause 로 펼친다.
 */
function serializeArg(arg: unknown): string {
  if (typeof arg === 'string') return arg.slice(0, 500)
  if (arg instanceof Error) {
    const d = describeError(arg)
    const parts = [`name=${d.name}`, `message="${d.message.slice(0, 300)}"`]
    if (d.code) parts.push(`code=${d.code}`)
    if (d.cause) parts.push(`cause={${d.cause}}`)
    return parts.join(' ')
  }
  try {
    const s = JSON.stringify(arg)
    return (s ?? '').slice(0, 500)
  } catch {
    try {
      return String(arg).slice(0, 500)
    } catch {
      return '[unserializable]'
    }
  }
}

/** 최근 로그 조회 (GET /api/system/logs). 콘솔을 못 보는 환경에서 진단용. */
export function getRecentLogs(limit = 200): BufferedLogLine[] {
  const n = Math.max(1, Math.min(RING_MAX, limit || 200))
  return ring.slice(-n)
}

class Logger {
  private prefix: string

  constructor(prefix: string = '') {
    this.prefix = prefix
  }

  private format(level: LogLevel, message: string): string {
    const timestamp = new Date().toISOString()
    const prefixStr = this.prefix ? `[${this.prefix}] ` : ''
    return `[${timestamp}] [${level.toUpperCase()}] ${prefixStr}${message}`
  }

  private record(level: LogLevel, message: string, args: unknown[]): void {
    const extra = args.length > 0 ? ` ${args.map(serializeArg).join(' ')}`.slice(0, 2000) : ''
    ring.push({ at: new Date().toISOString(), level, message: `${message}${extra}` })
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX)
  }

  info(message: string, ...args: unknown[]): void {
    this.record('info', message, args)
    console.log(this.format('info', message), ...args)
  }

  warn(message: string, ...args: unknown[]): void {
    this.record('warn', message, args)
    console.warn(this.format('warn', message), ...args)
  }

  error(message: string, ...args: unknown[]): void {
    this.record('error', message, args)
    console.error(this.format('error', message), ...args)
  }

  debug(message: string, ...args: unknown[]): void {
    if (ENV.LOGGING.DEBUG) {
      this.record('debug', message, args)
      console.debug(this.format('debug', message), ...args)
    }
  }
}

export const logger = new Logger()
