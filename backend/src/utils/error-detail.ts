/**
 * 에러 원인이 로그에서 사라지는 문제(무음 실패) 방지.
 *
 * AbortError/TimeoutError 는 DOMException 이라 JSON.stringify 결과가 "{}" 다.
 * `logger.warn(msg, error)` 로 남기면 원인이 사라져 "타임아웃인지 단절인지"를
 * 구분할 수 없다(백단 로그: "Queued chat flush errored ...: {}").
 * 이름·메시지·코드·cause 를 문자열로 펼쳐서 항상 사람이 읽을 수 있게 한다.
 */
export interface ErrorDetail {
  name: string
  message: string
  code?: string
  cause?: string
  elapsedMs?: number
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined)

function describeCause(cause: unknown): string | undefined {
  if (cause === null || cause === undefined) return undefined
  if (typeof cause === 'string') return cause.slice(0, 200)
  if (typeof cause !== 'object') return String(cause).slice(0, 200)
  const c = cause as { name?: unknown; message?: unknown; code?: unknown }
  const parts = [str(c.name), str(c.code) ? `code=${str(c.code)}` : undefined, str(c.message) ? `message="${str(c.message)!.slice(0, 200)}"` : undefined]
  const inner = parts.filter(Boolean).join(' ')
  return inner || undefined
}

/** 에러에서 사람이 읽을 수 있는 원인 문자열을 만든다(빈 객체 금지). */
export function describeError(error: unknown, elapsedMs?: number): ErrorDetail {
  if (error === null || error === undefined) {
    return { name: 'Unknown', message: 'no error object', elapsedMs }
  }
  if (typeof error !== 'object') {
    return { name: typeof error, message: String(error).slice(0, 200), elapsedMs }
  }
  const e = error as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown }
  const detail: ErrorDetail = {
    name: str(e.name) ?? 'Error',
    message: str(e.message) ?? '(no message)',
    elapsedMs,
  }
  const code = str(e.code)
  if (code) detail.code = code
  const cause = describeCause(e.cause)
  if (cause) detail.cause = cause
  return detail
}

/** 로그에 붙일 한 줄 문자열. */
export function formatErrorDetail(error: unknown, elapsedMs?: number): string {
  const d = describeError(error, elapsedMs)
  const parts = [`name=${d.name}`, `message="${d.message.slice(0, 200)}"`]
  if (d.code) parts.push(`code=${d.code}`)
  if (d.cause) parts.push(`cause={${d.cause}}`)
  if (typeof d.elapsedMs === 'number') parts.push(`elapsed=${d.elapsedMs}ms`)
  return parts.join(' ')
}

/** 중단(AbortError)·타임아웃(TimeoutError) 판정. 이름이 비면 코드/메시지로 보완한다. */
export function isAbortOrTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { name?: unknown; code?: unknown; message?: unknown }
  const name = str(e.name)
  if (name === 'AbortError' || name === 'TimeoutError') return true
  const code = str(e.code)
  if (code && ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(code.toUpperCase())) {
    return true
  }
  const message = (str(e.message) ?? '').toLowerCase()
  return message.includes('timed out') || message.includes('timeout')
}
