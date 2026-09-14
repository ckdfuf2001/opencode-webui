import { describe, it, expect } from 'vitest'
import { isValidCron, matchesCron } from '../../src/services/scheduler'

describe('scheduler cron', () => {
  it('should validate 5-field crons', () => {
    expect(isValidCron('0 9 * * *')).toBe(true)
    expect(isValidCron('*/5 * * * *')).toBe(true)
    expect(isValidCron('0 9 1 * 1')).toBe(true)
    expect(isValidCron('* * * *')).toBe(false)
    expect(isValidCron('0 9 * *')).toBe(false)
    expect(isValidCron('invalid')).toBe(false)
    expect(isValidCron('60 24 * * *')).toBe(true) // expandField will filter out of range, but still valid syntax
  })

  it('should match cron correctly', () => {
    const d = new Date(2026, 0, 15, 9, 0) // 2026-01-15 09:00, Thursday (4)
    expect(matchesCron('0 9 * * *', d)).toBe(true)
    expect(matchesCron('0 10 * * *', d)).toBe(false)
    expect(matchesCron('*/15 * * * *', new Date(2026,0,15,9,30))).toBe(true)
    expect(matchesCron('*/15 * * * *', new Date(2026,0,15,9,31))).toBe(false)
  })

  it('should reject invalid cron via matchesCron', () => {
    expect(matchesCron('bad cron', new Date())).toBe(false)
    expect(matchesCron('0 9 * *', new Date())).toBe(false)
  })
})
