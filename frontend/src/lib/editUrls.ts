/**
 * C5-4 (D64): 편집 모드 URL 규칙.
 * - 본 파일 편집: /edit/<워크스페이스 경로>
 * - 첨부 편집: /edit/<부모 경로>/-/<파트 경로>
 * 경로·파트에 모두 `/`가 들어가므로 `/-/`를 구분자로 고정한다.
 * 각 세그먼트는 encodeURIComponent로 인코딩한다.
 */

export function encodePathSegments(p: string): string {
  return p
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
}

function currentSearch(): string {
  try {
    return typeof window !== 'undefined' ? window.location.search : ''
  } catch {
    return ''
  }
}

export function editUrlForFile(filePath: string): string {
  return `/edit/${encodePathSegments(filePath)}${currentSearch()}`
}

export function editUrlForAttachment(parentPath: string, part: string): string {
  return `/edit/${encodePathSegments(parentPath)}/-/${encodePathSegments(part)}${currentSearch()}`
}

export type ParsedEditUrl =
  | { kind: 'file'; path: string }
  | { kind: 'attachment'; parentPath: string; part: string }

export function parseEditUrl(pathname: string): ParsedEditUrl | null {
  const prefix = '/edit/'
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  if (!rest) return null
  const segs = rest.split('/')
  const dash = segs.indexOf('-')
  try {
    if (dash < 0) {
      const decoded = segs.map((s) => decodeURIComponent(s)).join('/')
      if (!decoded) return null
      return { kind: 'file', path: decoded }
    }
    const parent = segs
      .slice(0, dash)
      .map((s) => decodeURIComponent(s))
      .join('/')
    const part = segs
      .slice(dash + 1)
      .map((s) => decodeURIComponent(s))
      .join('/')
    if (!parent || !part) return null
    return { kind: 'attachment', parentPath: parent, part }
  } catch {
    return null
  }
}

export function baseNameOf(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i < 0 ? norm : norm.slice(i + 1)
}
