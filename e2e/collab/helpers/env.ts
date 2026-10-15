import path from 'node:path'

/** webServer가 만든 격리 워크스페이스. */
export function workspaceDir(): string {
  const dir = process.env.COLLAB_E2E_WS
  if (!dir) throw new Error('COLLAB_E2E_WS is not set (run via test:e2e:collab)')
  return dir
}

/** 테스트마다 새 이름의 복사본을 쓴다 (room 재사용 금지). */
export function uniqueRel(testSlug: string, index: number): string {
  const stamp = Date.now().toString(36)
  return path.posix.join('repos', 'collab-e2e', `${testSlug}-${stamp}-${index}.pptx`)
}

export function absForRel(rel: string): string {
  return path.join(workspaceDir(), ...rel.split('/'))
}

export function backendBase(): string {
  return 'http://127.0.0.1:5011'
}
