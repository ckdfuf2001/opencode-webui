import { describe, expect, test, afterEach, vi } from 'vitest'
import { guid } from '../src/lib/ooxmlGuid'

/**
 * C2-a: OOXML GUID `{8-4-4-4-12}` (대문자).
 * crypto.randomUUID()는 secure context 전용이라 http에서 undefined다.
 * getRandomValues 기반이라 http(폰)에서도 동작해야 한다.
 */

const GUID_RE = /^\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}$/

describe('ooxmlGuid', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('형식: {8-4-4-4-12} 대문자', () => {
    for (let i = 0; i < 10; i++) {
      expect(guid()).toMatch(GUID_RE)
    }
  })

  test('버전 자리 4, variant 자리 8/9/a/b', () => {
    for (let i = 0; i < 50; i++) {
      const g = guid()
      const parts = g.slice(1, -1).split('-')
      expect(parts[2]![0]).toBe('4')
      expect('89AB').toContain(parts[3]![0]!)
    }
  })

  test('2000회 고유', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i++) seen.add(guid())
    expect(seen.size).toBe(2000)
  })

  test('randomUUID 없이도 동작한다 (http 상당)', () => {
    const getRandomValues = (globalThis.crypto as Crypto).getRandomValues.bind(globalThis.crypto)
    // randomUUID만 없는 crypto 스텁 — getRandomValues는 유지한다.
    vi.stubGlobal('crypto', { getRandomValues })
    expect((globalThis as Record<string, unknown>).crypto).not.toHaveProperty('randomUUID')
    for (let i = 0; i < 100; i++) {
      expect(guid()).toMatch(GUID_RE)
    }
  })
})
