import { describe, it, expect } from 'vitest'
import {
  normSlash,
  toWsPath,
  toDisplayPath,
  isInRepo,
  absToWsPath,
  getDirectory,
  getFilename,
  getRepoRel,
} from '../../src/lib/repoPath'

describe('repoPath', () => {
  describe('normSlash', () => {
    it('백슬래시를 슬래시로 변환', () => {
      expect(normSlash('a\\b\\c')).toBe('a/b/c')
    })
    it('선행 ./ 제거', () => {
      expect(normSlash('./a/b')).toBe('a/b')
    })
    it('중복 슬래시 축약', () => {
      expect(normSlash('a//b///c')).toBe('a/b/c')
    })
    it('양끝 슬래시 제거', () => {
      expect(normSlash('/a/b/')).toBe('a/b')
      expect(normSlash('a/b')).toBe('a/b')
    })
    it('빈 문자열 처리', () => {
      expect(normSlash('')).toBe('')
    })
  })

  describe('toWsPath', () => {
    it('repoRel을 repoRoot 앞에 붙임', () => {
      expect(toWsPath('src/a.ts', 'repoA')).toBe('repoA/src/a.ts')
    })
    it('이미 wsPath면 그대로 반환 (멱등성)', () => {
      expect(toWsPath('repoA/src/a.ts', 'repoA')).toBe('repoA/src/a.ts')
    })
    it('repoRoot가 빈 문자열이면 repoRel 그대로', () => {
      expect(toWsPath('src/a.ts', '')).toBe('src/a.ts')
    })
    it('repoRoot와 repoRel이 같으면 그대로', () => {
      expect(toWsPath('repoA', 'repoA')).toBe('repoA')
    })
    it('repoRoot가 repoRel의 prefix면 그대로', () => {
      expect(toWsPath('repoA/src/a.ts', 'repoA')).toBe('repoA/src/a.ts')
    })
    it('공백 포함 경로', () => {
      expect(toWsPath('my folder/file.ts', 'repoA')).toBe('repoA/my folder/file.ts')
    })
    it('백슬래시 경로 정규화', () => {
      expect(toWsPath('src\\a.ts', 'repoA')).toBe('repoA/src/a.ts')
    })
    it('repoRoot가 다른 레포의 prefix가 아닐 때(경계 검사)', () => {
      // repoRoot='repo'일 때 'repoAB/x.ts'가 잘못 매칭되지 않아야 함
      expect(toWsPath('repoAB/x.ts', 'repo')).toBe('repo/repoAB/x.ts')
    })
  })

  describe('toDisplayPath', () => {
    it('wsPath에서 repoRoot prefix 제거', () => {
      expect(toDisplayPath('repoA/src/a.ts', 'repoA')).toBe('src/a.ts')
    })
    it('레포 밖이면 원본 반환', () => {
      expect(toDisplayPath('other/src/a.ts', 'repoA')).toBe('other/src/a.ts')
    })
    it('repoRoot가 빈 문자열이면 원본 반환', () => {
      expect(toDisplayPath('src/a.ts', '')).toBe('src/a.ts')
    })
    it('wsPath가 repoRoot와 같으면 빈 문자열', () => {
      expect(toDisplayPath('repoA', 'repoA')).toBe('')
    })
  })

  describe('isInRepo', () => {
    it('레포 안이면 true', () => {
      expect(isInRepo('repoA/src/a.ts', 'repoA')).toBe(true)
    })
    it('레포 루트면 true', () => {
      expect(isInRepo('repoA', 'repoA')).toBe(true)
    })
    it('레포 밖이면 false', () => {
      expect(isInRepo('repoB/src/a.ts', 'repoA')).toBe(false)
    })
    it('다른 레포의 prefix가 같아도 false', () => {
      expect(isInRepo('repoAB/src/a.ts', 'repoA')).toBe(false)
    })
  })

  describe('absToWsPath', () => {
    it('workspaceRoot 아래 경로를 wsPath로 변환', () => {
      expect(absToWsPath('/workspace/repoA/src/a.ts', '/workspace')).toBe('repoA/src/a.ts')
    })
    it('workspaceRoot 밖이면 null', () => {
      expect(absToWsPath('/other/repoA/src/a.ts', '/workspace')).toBeNull()
    })
    it('workspaceRoot 자체가 들어오면 빈 문자열', () => {
      expect(absToWsPath('/workspace', '/workspace')).toBe('')
    })
    it('Windows 경로 처리', () => {
      expect(absToWsPath('C:\\workspace\\repoA\\src\\a.ts', 'C:\\workspace')).toBe('repoA/src/a.ts')
    })
  })

  describe('getDirectory', () => {
    it('파일의 디렉터리 반환', () => {
      expect(getDirectory('repoA/src/a.ts')).toBe('repoA/src')
    })
    it('루트 파일은 빈 문자열', () => {
      expect(getDirectory('repoA/file.ts')).toBe('repoA')
    })
    it('루트 디렉터리는 빈 문자열', () => {
      expect(getDirectory('repoA')).toBe('')
    })
  })

  describe('getFilename', () => {
    it('파일명 추출', () => {
      expect(getFilename('repoA/src/a.ts')).toBe('a.ts')
    })
    it('루트 파일', () => {
      expect(getFilename('repoA/file.ts')).toBe('file.ts')
    })
  })

  describe('getRepoRel', () => {
    it('wsPath에서 repoRel 추출', () => {
      expect(getRepoRel('repoA/src/a.ts', 'repoA')).toBe('src/a.ts')
    })
    it('레포 루트면 빈 문자열', () => {
      expect(getRepoRel('repoA', 'repoA')).toBe('')
    })
    it('레포 밖이면 null', () => {
      expect(getRepoRel('repoB/src/a.ts', 'repoA')).toBeNull()
    })
    it('repoRoot가 빈 문자열이면 원본', () => {
      expect(getRepoRel('src/a.ts', '')).toBe('src/a.ts')
    })
  })

  describe('경계 검사', () => {
    it('repoRoot가 다른 레포의 prefix가 아닐 때', () => {
      // repoRoot='repo'일 때 'repoAB/x.ts'가 'repo/'로 시작하지 않아야 함
      expect(toWsPath('repoAB/x.ts', 'repo')).toBe('repo/repoAB/x.ts')
      expect(isInRepo('repoAB/x.ts', 'repoA')).toBe(false)
    })
    it('빈 repoRoot', () => {
      expect(toWsPath('src/a.ts', '')).toBe('src/a.ts')
      expect(toDisplayPath('src/a.ts', '')).toBe('src/a.ts')
      expect(isInRepo('src/a.ts', '')).toBe(false)
    })
  })
})