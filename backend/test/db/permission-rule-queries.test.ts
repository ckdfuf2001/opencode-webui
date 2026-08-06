import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as db from '../../src/db/permission-rule-queries'

const mockDb = {
  prepare: vi.fn(),
  exec: vi.fn(),
  close: vi.fn(),
  transaction: vi.fn()
} as any

vi.mock('bun:sqlite', () => ({
  Database: vi.fn(() => mockDb)
}))

const ruleRow = {
  id: 1,
  repo_id: 1,
  permission: 'bash',
  pattern: 'npm run build',
  created_at: 1710000000000
}

describe('Permission Rule Queries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('listPermissionRules', () => {
    it('should list all rules when no repoId is provided', () => {
      const stmt = { all: vi.fn().mockReturnValue([ruleRow]) }
      mockDb.prepare.mockReturnValue(stmt)

      const result = db.listPermissionRules(mockDb)

      expect(mockDb.prepare).toHaveBeenCalledWith(
        'SELECT * FROM permission_rules ORDER BY created_at DESC'
      )
      expect(result).toEqual([{
        id: 1,
        repoId: 1,
        permission: 'bash',
        pattern: 'npm run build',
        createdAt: 1710000000000
      }])
    })

    it('should filter by repoId when provided', () => {
      const stmt = { all: vi.fn().mockReturnValue([]) }
      mockDb.prepare.mockReturnValue(stmt)

      db.listPermissionRules(mockDb, 2)

      expect(mockDb.prepare).toHaveBeenCalledWith(
        'SELECT * FROM permission_rules WHERE repo_id = ? ORDER BY created_at DESC'
      )
      expect(stmt.all).toHaveBeenCalledWith(2)
    })
  })

  describe('getPermissionRuleById', () => {
    it('should return rule by ID', () => {
      const stmt = { get: vi.fn().mockReturnValue(ruleRow) }
      mockDb.prepare.mockReturnValue(stmt)

      const result = db.getPermissionRuleById(mockDb, 1)

      expect(result).toEqual({
        id: 1,
        repoId: 1,
        permission: 'bash',
        pattern: 'npm run build',
        createdAt: 1710000000000
      })
    })

    it('should return null for missing rule', () => {
      const stmt = { get: vi.fn().mockReturnValue(undefined) }
      mockDb.prepare.mockReturnValue(stmt)

      expect(db.getPermissionRuleById(mockDb, 999)).toBeNull()
    })
  })

  describe('createPermissionRule', () => {
    it('should return existing rule when a duplicate exists', () => {
      const dupCheckStmt = { get: vi.fn().mockReturnValue(ruleRow) }
      mockDb.prepare.mockReturnValue(dupCheckStmt)

      const result = db.createPermissionRule(mockDb, {
        repoId: 1,
        permission: 'bash',
        pattern: 'npm run build'
      })

      expect(result.id).toBe(1)
      expect(dupCheckStmt.get).toHaveBeenCalledWith(1, 'bash', 'npm run build')
    })

    it('should insert a new rule when no duplicate exists', () => {
      const dupCheckStmt = { get: vi.fn().mockReturnValue(undefined) }
      const insertStmt = { run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 2 }) }
      const selectStmt = { get: vi.fn().mockReturnValue({ ...ruleRow, id: 2 }) }

      mockDb.prepare
        .mockReturnValueOnce(dupCheckStmt)
        .mockReturnValueOnce(insertStmt)
        .mockReturnValueOnce(selectStmt)

      const result = db.createPermissionRule(mockDb, {
        repoId: 1,
        permission: 'bash',
        pattern: 'npm run build'
      })

      expect(insertStmt.run).toHaveBeenCalledWith(1, 'bash', 'npm run build', expect.any(Number))
      expect(result.id).toBe(2)
    })
  })

  describe('deletePermissionRule', () => {
    it('should delete rule and return true', () => {
      const stmt = { run: vi.fn().mockReturnValue({ changes: 1 }) }
      mockDb.prepare.mockReturnValue(stmt)

      expect(db.deletePermissionRule(mockDb, 1)).toBe(true)
      expect(stmt.run).toHaveBeenCalledWith(1)
    })

    it('should return false when rule does not exist', () => {
      const stmt = { run: vi.fn().mockReturnValue({ changes: 0 }) }
      mockDb.prepare.mockReturnValue(stmt)

      expect(db.deletePermissionRule(mockDb, 999)).toBe(false)
    })
  })
})
