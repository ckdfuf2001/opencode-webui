/**
 * C5-4 (D64): 편집 모드 URL 규칙.
 * - 본 파일 편집: /edit/<워크스페이스 경로>
 * - 첨부 편집: /edit/<부모 경로>/-/<파트 경로>
 * 문법의 단일 진실은 @opencode-webui/shared (서버·테스트와 공유).
 * D71 `/{상위}/{하위}` 전환은 shared 파서 교체로 함께 바뀐다.
 */
import {
  encodePathSegments,
  parseEditPath as parseEditUrl,
} from '@opencode-webui/shared/lib/editPath'
import type { ParsedEditPath as ParsedEditUrl } from '@opencode-webui/shared/lib/editPath'

export { encodePathSegments, parseEditUrl }
export type { ParsedEditUrl }

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

export function editUrlForAttachment(parentPath: string, part: string, partHash?: string): string {
  const base = `/edit/${encodePathSegments(parentPath)}/-/${encodePathSegments(part)}`
  const q = new URLSearchParams(currentSearch())
  if (partHash) q.set('partHash', partHash)
  const qs = q.toString()
  return qs ? `${base}?${qs}` : base
}

/**
 * C5-4 (D64) + P0-3: 새 탭으로 연다. `noopener` 피처는 반환값을 null로 만들어
 * 차단 감지를 막으므로 쓰지 않는다. 대신 opener를 수동으로 끊는다.
 * 차단되면 null을 돌려준다 (호출자가 토스트+링크를 보여준다).
 * 이렇게 열린 탭은 "스크립트로 연 탭"이라 window.close()가 동작한다.
 */
export function openInNewTab(url: string): Window | null {
  try {
    const w = window.open(url, '_blank')
    if (!w) return null
    try {
      w.opener = null
    } catch {
      /* 크로스 오리진이면 끊기만 안 된다 — 탭은 열렸다 */
    }
    return w
  } catch {
    return null
  }
}

export function baseNameOf(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i < 0 ? norm : norm.slice(i + 1)
}
