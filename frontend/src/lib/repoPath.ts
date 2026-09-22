export type WsPath = string      // 'repoA/src/foo.ts'
export type RepoRel = string     // 'src/foo.ts'

/** 구분자 통일 + 선행 './' 제거 + 중복 슬래시 축약 + 양끝 슬래시 제거 */
export function normSlash(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
          .replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '')
}

/** repoRel → wsPath. 호출자가 repoRel임을 아는 경우에만 사용. */
export function toWsPath(repoRel: RepoRel, repoRoot: string): WsPath {
  const r = normSlash(repoRoot)
  const p = normSlash(repoRel)
  if (!r) return p
  if (p === r || p.startsWith(r + '/')) return p   // 멱등성 보장
  return `${r}/${p}`
}

/** wsPath → 표시용 repoRel. 레포 밖이면 wsPath 그대로 반환(정보 손실 방지). */
export function toDisplayPath(ws: WsPath, repoRoot: string): string {
  const r = normSlash(repoRoot)
  const p = normSlash(ws)
  if (!r) return p
  if (p === r) return ''
  return p.startsWith(r + '/') ? p.slice(r.length + 1) : p
}

/** wsPath가 주어진 레포 루트 안에 있는지 확인 */
export function isInRepo(ws: WsPath, repoRoot: string): boolean {
  const r = normSlash(repoRoot)
  const p = normSlash(ws)
  if (!r) return false
  return p === r || p.startsWith(r + '/')
}

/** 절대경로 → wsPath. workspaceRoot 밖이면 null. */
export function absToWsPath(abs: string, workspaceRoot: string): WsPath | null {
  const absNorm = normSlash(abs)
  const wsNorm = normSlash(workspaceRoot)
  if (!absNorm.startsWith(wsNorm + '/') && absNorm !== wsNorm) {
    return null
  }
  return absNorm.slice(wsNorm.length + (absNorm.startsWith(wsNorm + '/') ? 1 : 0))
}

/** 파일 경로에서 디렉터리 부분 추출 (repoRel 기준) */
export function getDirectory(wsPath: WsPath): string {
  const normalized = normSlash(wsPath)
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(0, idx) : ''
}

/** 파일 경로에서 파일명만 추출 */
export function getFilename(wsPath: WsPath): string {
  const normalized = normSlash(wsPath)
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

/** wsPath가 repoRoot 내부에 있는지 확인하고 상대경로 반환 */
export function getRepoRel(wsPath: WsPath, repoRoot: string): string | null {
  const r = normSlash(repoRoot)
  const p = normSlash(wsPath)
  if (!r) return p
  if (p === r) return ''
  if (p.startsWith(r + '/')) return p.slice(r.length + 1)
  return null
}