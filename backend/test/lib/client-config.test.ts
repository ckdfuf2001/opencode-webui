import { describe, it, expect } from 'vitest'
import { resolveRuntimeApiBase, isLoopbackHost } from '@opencode-webui/shared/config/client'

describe('isLoopbackHost', () => {
  it('treats empty/localhost/loopback as loopback', () => {
    expect(isLoopbackHost('')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('192.168.0.5')).toBe(false)
    expect(isLoopbackHost('example.com')).toBe(false)
  })
})

describe('resolveRuntimeApiBase (Connected 오판 방지)', () => {
  it('keeps baked value on loopback pages (dev/exe-local)', () => {
    expect(resolveRuntimeApiBase({ baked: '', pageProtocol: 'http:', pageHostname: 'localhost' })).toBe('')
    expect(
      resolveRuntimeApiBase({ baked: 'http://localhost:5001', pageProtocol: 'http:', pageHostname: '127.0.0.1' }),
    ).toBe('http://localhost:5001')
  })
  it('forces same-origin when a loopback-baked URL would miss the serving backend (LAN/phone)', () => {
    expect(
      resolveRuntimeApiBase({ baked: 'http://localhost:5001', pageProtocol: 'http:', pageHostname: '192.168.0.5' }),
    ).toBe('')
    expect(resolveRuntimeApiBase({ baked: '', pageProtocol: 'http:', pageHostname: '192.168.0.5' })).toBe('')
  })
  it('respects an explicit remote baked URL', () => {
    expect(
      resolveRuntimeApiBase({ baked: 'https://api.example.com', pageProtocol: 'https:', pageHostname: '192.168.0.5' }),
    ).toBe('https://api.example.com')
  })
  it('leaves non-http pages alone', () => {
    expect(resolveRuntimeApiBase({ baked: 'http://localhost:5001', pageProtocol: 'file:' })).toBe(
      'http://localhost:5001',
    )
  })
})
