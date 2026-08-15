import { describe, it, expect, beforeEach } from 'vitest'
import { markRequestBusy, clearRequestBusy, isOpenCodeServerBusy } from '../../src/services/busy-tracker'

describe('busy-tracker', () => {
  beforeEach(() => {
    while (isOpenCodeServerBusy()) {
      clearRequestBusy()
    }
  })

  it('reports not busy initially', () => {
    expect(isOpenCodeServerBusy()).toBe(false)
  })

  it('reports busy while a request is marked and idle after clearing', () => {
    markRequestBusy()
    expect(isOpenCodeServerBusy()).toBe(true)
    clearRequestBusy()
    expect(isOpenCodeServerBusy()).toBe(false)
  })

  it('tracks overlapping requests', () => {
    markRequestBusy()
    markRequestBusy()
    expect(isOpenCodeServerBusy()).toBe(true)
    clearRequestBusy()
    expect(isOpenCodeServerBusy()).toBe(true)
    clearRequestBusy()
    expect(isOpenCodeServerBusy()).toBe(false)
  })

  it('never goes negative when cleared without a matching mark', () => {
    clearRequestBusy()
    clearRequestBusy()
    expect(isOpenCodeServerBusy()).toBe(false)
  })
})
