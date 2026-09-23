import type { FileInfo } from '@/types/files'

export type FileSort = 'name-asc' | 'name-desc' | 'mtime-asc' | 'mtime-desc'

function mtimeOf(f: FileInfo): number {
  const t = new Date(f.lastModified ?? 0).getTime()
  return Number.isNaN(t) ? 0 : t
}

function byName(a: FileInfo, b: FileInfo): number {
  return a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' })
}

/**
 * 탐색기 정렬 (루트 + 하위 폴더 공통).
 * 디렉터리 우선, 그 다음 선택 기준. 입력 배열을 건드리지 않고 복사본을 돌려준다
 * (react-query 캐시를 직접 sort하면 저장된 순서가 망가진다).
 */
export function sortFileInfos(list: FileInfo[], sortBy: FileSort): FileInfo[] {
  const arr = [...list]
  arr.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    switch (sortBy) {
      case 'name-desc':
        return byName(b, a)
      case 'mtime-asc':
        return mtimeOf(a) - mtimeOf(b) || byName(a, b)
      case 'mtime-desc':
        return mtimeOf(b) - mtimeOf(a) || byName(a, b)
      default:
        return byName(a, b)
    }
  })
  return arr
}
