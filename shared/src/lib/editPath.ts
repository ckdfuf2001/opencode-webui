/**
 * C6c-a0: 편집 URL 문법의 단일 진실 (서버·클라이언트·테스트 공유).
 * - 파일 편집: /edit/<워크스페이스 경로>
 * - 첨부 편집: /edit/<부모 경로>/-/<파트 경로>
 * 경로·파트에 모두 `/`가 들어가므로 `/-/`를 구분자로 고정한다.
 * 각 세그먼트는 encodeURIComponent로 인코딩한다 (한글·공백 왕복 보장).
 * D64에서 도입된 스킴이다. `/{상위}/{하위}` 전환(D71)은 이 파서 교체로
 * 서버·클라이언트·테스트가 함께 바뀐다.
 */

export function encodePathSegments(p: string): string {
  return p
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
}

export type ParsedEditPath = { kind: 'file'; path: string } | { kind: 'attachment'; parentPath: string; part: string }

export function parseEditPath(pathname: string): ParsedEditPath | null {
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
