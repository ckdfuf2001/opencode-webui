import { useEffect, useRef, useSyncExternalStore } from 'react'

/**
 * C4-6 H2: 탭당 같은 파일은 하나의 FilePreview만 마운트한다.
 * 미리보기(패널)와 큰 화면(시트)이 같은 파일을 열면 패널 쪽이 DocumentPreview를
 * 내리고 정적 안내만 둔다. 편집 중인 화면은 절대 내리지 않는다(데이터 보호).
 */
export type OpenFileSurface = 'panel' | 'sheet'

interface OpenFileEntry {
  id: number
  surface: OpenFileSurface
  path: string
  editing: boolean
}

let nextId = 1
const entries = new Map<number, OpenFileEntry>()
let version = 0
const listeners = new Set<() => void>()

function emit(): void {
  version += 1
  listeners.forEach((l) => {
    try {
      l()
    } catch {
      /* 무시 */
    }
  })
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/')
}

function unregister(id: number): void {
  if (entries.delete(id)) emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshotVersion(): number {
  return version
}

/** 다른 화면이 같은 파일을 쓰고 있으면 'edit'(편집 중) 또는 'sheet'(큰 화면). */
export type ShadowReason = 'edit' | 'sheet' | null

function computeShadow(selfId: number | null, surface: OpenFileSurface, path: string | null, editing: boolean): ShadowReason {
  if (!path || editing) return null
  const key = normPath(path)
  for (const [id, e] of entries) {
    if (id === selfId) continue
    if (normPath(e.path) !== key) continue
    if (e.editing) return 'edit'
    if (e.surface === 'sheet' && surface === 'panel') return 'sheet'
  }
  return null
}

/**
 * FilePreview가 마운트한 파일을 등록하고, 남이 같은 파일을 열면
 * unmount 사유를 반환한다. 편집 중이면 절대 양보하지 않는다.
 */
export function useShadowedFile(surface: OpenFileSurface, path: string | null, editing: boolean): ShadowReason {
  const idRef = useRef<number | null>(null)
  if (idRef.current == null) {
    idRef.current = nextId
    nextId += 1
  }
  const id = idRef.current
  // 마운트/경로·편집 변경마다 등록·갱신하고, 언마운트 때 해제한다.
  // 같은 id로는 항상 같은 entry를 갱신하므로 중복 등록이 없다.
  useEffect(() => {
    entries.set(id, { id, surface, path: path ?? '', editing })
    emit()
    return () => {
      unregister(id)
    }
  }, [id, surface, path, editing])
  const ver = useSyncExternalStore(subscribe, snapshotVersion)
  void ver
  return computeShadow(id, surface, path, editing)
}
