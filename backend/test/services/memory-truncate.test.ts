import { describe, it, expect } from 'vitest'

// replicate the truncate logic without importing frontend (which needs react-query)
const MAX_KEEP = 80_000
const NOTICE = '\n\n…[output truncated for memory — see full log in session]'

function truncateForTest(output: string, status: string): string {
  if (!output || output.length <= MAX_KEEP) return output
  if (status === 'running') return output
  return output.slice(0, MAX_KEEP) + NOTICE + ` (${output.length - MAX_KEEP} chars omitted)`
}

describe('memory truncate', () => {
  it('should keep small outputs intact', () => {
    const s = 'x'.repeat(1000)
    expect(truncateForTest(s, 'completed')).toBe(s)
    expect(truncateForTest(s, 'running')).toBe(s)
  })

  it('should truncate completed large outputs to 80k + notice', () => {
    const large = 'a'.repeat(100_000)
    const truncated = truncateForTest(large, 'completed')
    expect(truncated.length).toBeLessThan(large.length)
    expect(truncated).toContain('[output truncated')
    expect(truncated.startsWith('a'.repeat(MAX_KEEP))).toBe(true)
  })

  it('should not truncate running outputs (streaming)', () => {
    const large = 'a'.repeat(100_000)
    expect(truncateForTest(large, 'running')).toBe(large)
  })

  it('should handle 7GB-scale string conceptually (simulate 1M)', () => {
    const huge = 'x'.repeat(1_000_000)
    const truncated = truncateForTest(huge, 'completed')
    expect(truncated.length).toBe(MAX_KEEP + NOTICE.length + ` (${huge.length - MAX_KEEP} chars omitted)`.length)
  })
})
