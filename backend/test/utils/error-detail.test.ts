import { describe, it, expect } from 'vitest'
import { describeError, formatErrorDetail, isAbortOrTimeoutError } from '../../src/utils/error-detail'

describe('describeError — 로그에서 원인이 사라지지 않게', () => {
  it('AbortError(DOMException)는 이름이 남는다 (JSON.stringify 는 "{}" 다)', () => {
    const err = new DOMException('This operation was aborted', 'AbortError')
    const detail = describeError(err)
    expect(detail.name).toBe('AbortError')
    expect(detail.message).toContain('aborted')
    expect(formatErrorDetail(err)).toContain('name=AbortError')
  })

  it('TimeoutError 는 이름이 남는다', () => {
    const err = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    expect(describeError(err).name).toBe('TimeoutError')
    expect(formatErrorDetail(err)).toContain('name=TimeoutError')
  })

  it('cause 의 code 까지 펼친다', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })
    const detail = describeError(err)
    expect(detail.message).toBe('fetch failed')
    expect(detail.cause).toContain('ECONNRESET')
    expect(formatErrorDetail(err)).toContain('code=ECONNRESET')
  })

  it('원인이 없으면 "(no message)" 로 명시한다 (빈 문자열 금지)', () => {
    const detail = describeError({})
    expect(detail.name).toBe('Error')
    expect(detail.message).toBe('(no message)')
    expect(formatErrorDetail({})).toContain('message="(no message)"')
  })

  it('elapsed 를 함께 남긴다', () => {
    expect(formatErrorDetail(new Error('x'), 1234)).toContain('elapsed=1234ms')
  })
})

describe('isAbortOrTimeoutError', () => {
  it('AbortError/TimeoutError 는 참', () => {
    expect(isAbortOrTimeoutError(new DOMException('aborted', 'AbortError'))).toBe(true)
    expect(isAbortOrTimeoutError(new DOMException('timeout', 'TimeoutError'))).toBe(true)
  })

  it('코드/메시지로도 판정한다', () => {
    expect(isAbortOrTimeoutError(Object.assign(new Error('x'), { code: 'UND_ERR_HEADERS_TIMEOUT' }))).toBe(true)
    expect(isAbortOrTimeoutError(new Error('The operation timed out'))).toBe(true)
  })

  it('그 외 오류는 거짓', () => {
    expect(isAbortOrTimeoutError(new TypeError('fetch failed'))).toBe(false)
    expect(isAbortOrTimeoutError(null)).toBe(false)
    expect(isAbortOrTimeoutError(undefined)).toBe(false)
  })
})
