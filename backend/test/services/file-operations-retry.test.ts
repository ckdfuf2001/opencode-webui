import { describe, it, expect } from 'vitest'
import { renameWithRetry } from '../../src/services/file-operations'

function codedError(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException
  e.code = code
  return e
}

describe('renameWithRetry (C7b EPERM)', () => {
  it('일시 EPERM 뒤 성공한다 (50/150ms 대기 후 재시도)', async () => {
    let calls = 0
    const fakeFs = {
      rename: async (_from: string, _to: string): Promise<void> => {
        calls += 1
        if (calls < 3) throw codedError('EPERM')
      },
    }
    const sleeps: number[] = []
    await renameWithRetry('a.tmp', 'a', {
      fs: fakeFs,
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
    })
    expect(calls).toBe(3)
    expect(sleeps).toEqual([50, 150])
  })

  it('3회 재시도 후에도 실패하면 마지막 에러로 던진다', async () => {
    let calls = 0
    const fakeFs = {
      rename: async (_from: string, _to: string): Promise<void> => {
        calls += 1
        throw codedError('EPERM')
      },
    }
    await expect(renameWithRetry('a.tmp', 'a', { fs: fakeFs, sleep: async () => {} })).rejects.toThrow('EPERM')
    expect(calls).toBe(4)
  })

  it('EPERM/EBUSY가 아니면 재시도하지 않는다', async () => {
    let calls = 0
    const fakeFs = {
      rename: async (_from: string, _to: string): Promise<void> => {
        calls += 1
        throw codedError('ENOENT')
      },
    }
    await expect(renameWithRetry('a.tmp', 'a', { fs: fakeFs, sleep: async () => {} })).rejects.toThrow('ENOENT')
    expect(calls).toBe(1)
  })
})
