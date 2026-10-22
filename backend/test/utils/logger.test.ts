import { describe, it, expect } from 'vitest'
import { logger, getRecentLogs } from '../../src/utils/logger'

describe('logger 링 버퍼 — 에러 원인이 사라지지 않는다', () => {
  it('AbortError(DOMException)는 이름·메시지가 남는다 (옛 "{}" 회귀)', () => {
    logger.warn('Queued chat flush errored for session ses_x:', new DOMException('This operation was aborted', 'AbortError'))
    const line = getRecentLogs(20).at(-1)!
    expect(line.message).not.toContain('{}')
    expect(line.message).toContain('name=AbortError')
    expect(line.message).toContain('This operation was aborted')
  })

  it('TimeoutError 도 남는다', () => {
    logger.warn('Proxy request timed out:', new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    const line = getRecentLogs(20).at(-1)!
    expect(line.message).toContain('name=TimeoutError')
  })

  it('Error 의 cause 코드까지 남는다', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })
    logger.error('Proxy request failed:', err)
    const line = getRecentLogs(20).at(-1)!
    expect(line.message).toContain('message="fetch failed"')
    expect(line.message).toContain('ECONNRESET')
  })

  it('일반 객체는 기존처럼 JSON 으로 남는다', () => {
    logger.info('plain', { a: 1 })
    expect(getRecentLogs(20).at(-1)!.message).toContain('{"a":1}')
  })
})
