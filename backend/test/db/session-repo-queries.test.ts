import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as db from '../../src/db/session-repo-queries'

const mockDb = {
  prepare: vi.fn(),
  exec: vi.fn(),
  close: vi.fn(),
  transaction: vi.fn(),
} as any

describe('Session Repo Queries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getSessionRepo', () => {
    it('should return repoId for mapped session', () => {
      const stmt = { get: vi.fn().mockReturnValue({ repo_id: 3 }) }
      mockDb.prepare.mockReturnValue(stmt)

      expect(db.getSessionRepo(mockDb, 'ses-1')).toBe(3)
      expect(stmt.get).toHaveBeenCalledWith('ses-1')
    })

    it('should return null when unmapped', () => {
      const stmt = { get: vi.fn().mockReturnValue(undefined) }
      mockDb.prepare.mockReturnValue(stmt)

      expect(db.getSessionRepo(mockDb, 'ses-x')).toBeNull()
    })
  })

  describe('setSessionRepoIfAbsent', () => {
    it('should insert on first write', () => {
      const stmt = { run: vi.fn().mockReturnValue({ changes: 1 }) }
      mockDb.prepare.mockReturnValue(stmt)

      expect(db.setSessionRepoIfAbsent(mockDb, 'ses-1', 2)).toBe(true)
      expect(stmt.run).toHaveBeenCalledWith('ses-1', 2, expect.any(Number))
    })

    it('should report false when row already exists', () => {
      const stmt = { run: vi.fn().mockReturnValue({ changes: 0 }) }
      mockDb.prepare.mockReturnValue(stmt)

      expect(db.setSessionRepoIfAbsent(mockDb, 'ses-1', 2)).toBe(false)
    })

    it('should reject invalid inputs', () => {
      expect(db.setSessionRepoIfAbsent(mockDb, '', 1)).toBe(false)
      expect(db.setSessionRepoIfAbsent(mockDb, 'ses-1', 0)).toBe(false)
      expect(db.setSessionRepoIfAbsent(mockDb, 'ses-1', -2)).toBe(false)
      expect(mockDb.prepare).not.toHaveBeenCalled()
    })
  })

  describe('deleteSessionRepoMapsByRepo', () => {
    it('should delete rows and return count', () => {
      const stmt = { run: vi.fn().mockReturnValue({ changes: 4 }) }
      mockDb.prepare.mockReturnValue(stmt)

      expect(db.deleteSessionRepoMapsByRepo(mockDb, 7)).toBe(4)
      expect(stmt.run).toHaveBeenCalledWith(7)
    })
  })
})
