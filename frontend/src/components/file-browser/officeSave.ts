import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { API_BASE_URL } from '@/config'
import { showToast } from '@/lib/toast'

/** 미리보기 편집 저장: 같은 자리에 덮어쓴다 (새 파일로 다운 아님).
 *
 *  X1c(P0): `ifMatch` (파일을 읽은 시점의 ETag) 를 주면 잠근다.
 *  POST 에 If-Match 로 되돌려 보낸다 → 디스크가 그 사이에 바뀌었으면 서버가 409.
 *  crypto.subtle 이 없는 환경(폰 http)에서도 안전하다(서버가 해시를 계산한다).
 *  PPT 는 서버 판정(collab/save)을 거친 뒤에 이 함수를 쓰므로 ifMatch 를 주지 않는다.
 */
export interface OfficeSaveConflict {
  status: number
  error?: string
  code?: string
  currentHash?: string | null
}

export interface OfficeSaveOk {
  name: string
  path: string
  size: number
  mimeType: string
  /** X1c: 저장 후의 ETag — 다음 If-Match 에 쓴다. */
  etag?: string
}

/** 저장 성공의 후처리(새 ETag 갱신용). */
export type OnSavedOffice = (bytes: Uint8Array, etag?: string) => void

export async function saveOfficeBytes(
  serverPath: string,
  fileName: string,
  blob: Blob,
  opts?: { ifMatch?: string | null },
): Promise<OfficeSaveOk | undefined> {
  const fd = new FormData()
  fd.append('file', new File([blob], fileName, { type: blob.type || 'application/octet-stream' }))
  const res = await fetch(`${API_BASE_URL}/api/files/${serverPath}?overwrite=1`, {
    method: 'POST',
    body: fd,
    ...(opts?.ifMatch ? { headers: { 'If-Match': opts.ifMatch } } : {}),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as OfficeSaveConflict | null
    const err = new Error(body?.error || `Save failed (${res.status})`) as Error & { conflict?: OfficeSaveConflict }
    if ((body?.error || body?.code) && res.status === 409) err.conflict = body ?? undefined
    throw err
  }
  // X1c: 응답의 ETag 헤더(또는 body.etag)를 돌려준다 — 다음 If-Match 에 쓴다.
  // JSON body 가 없어도(서버가 body 없이 응답) 헤더만으로 갱신되도록 한다.
  const hdr = res.headers.get('etag')?.replace(/"/g, '') ?? undefined
  const body = (await res.json().catch(() => null)) as OfficeSaveOk | null
  if (body) return { ...body, etag: body.etag ?? hdr }
  return hdr ? { name: fileName, path: serverPath, size: blob.size, mimeType: blob.type, etag: hdr } : undefined
}

type SaveHandle = {
  save: () => Promise<Blob>
  markClean: () => void
} | null

/**
 * 파일별 저장 완료 신호. B1(b): 이게 없으면 수신자는 "어느 파일의 저장 완료인지"를
 * 알 수 없어, 다른 뷰어의 저장 완료에 편집이 종료된다(B1: XLSX 편집 중 PPT 저장이
 * XLSX 편집을 죽였다). 구버전 응답(path 없음)은 호출자가 골라 쓸 수 있게 통과시킨다.
 */
export interface OfficeSaveDoneDetail {
  ok: boolean
  path?: string
}

/**
 * 뷰어 툴바 저장 가로채기 + 상단 저장 버튼 공용.
 * handle이 없거나 저장 중이면 false.
 * onSaved는 저장된 바이트 후처리용 (모델 기준 상태 갱신 등).
 * onError는 409(외부 변경) 같은 충돌을 상위에서 배너·다운로드로 다룰 수 있게 준다.
 * X1d(P0): `requireIfMatch` 를 넘긴 호출자만 If-Match 가 필수다(X1c 의 단독 저장 잠금,
 * XlsxViewer). 다른 뷰어(DOCX 등)는 ifMatch 없어도 저장한다 — 서버도 If-Match 가
 * 없으면 기존대로 덮어쓴다. throw 는 ifMatch 를 요구한 쪽에만 적용한다.
 */
export function useOfficeSave(
  serverPath: string,
  fileName: string,
  handle: SaveHandle,
  onSaved?: (bytes: Uint8Array, etag?: string) => void,
  hooks?: {
    ifMatch?: string | null
    requireIfMatch?: boolean
    onError?: (conflict: OfficeSaveConflict | null, e: unknown) => void
  },
) {
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const save = useCallback(async (): Promise<boolean> => {
    if (!handle || saving) return false
    setSaving(true)
    try {
      // X1d: requireIfMatch 옵션을 넘긴 호출자에만 적용한다. ETag 가 아직 없으면
      // 저장해도 잠금을 걸 수 없으므로 저장 자체를 막는다(조용한 덮어쓰기 방지).
      if (hooks?.requireIfMatch && !hooks?.ifMatch) throw new Error('File not loaded yet')
      const blob = await handle.save()
      const ok = await saveOfficeBytes(serverPath, fileName, blob, { ifMatch: hooks?.ifMatch })
      handle.markClean()
      try {
        onSaved?.(new Uint8Array(await blob.arrayBuffer()), ok?.etag)
      } catch {
        // 후처리 실패는 저장 성공과 무관
      }
      void queryClient.invalidateQueries({ queryKey: ['files'] })
      showToast.success('저장했습니다')
      window.dispatchEvent(
        new CustomEvent<OfficeSaveDoneDetail>('officeSaveDone', { detail: { ok: true, path: serverPath } }),
      )
      return true
    } catch (e) {
      const conflict = (e as { conflict?: OfficeSaveConflict })?.conflict ?? null
      hooks?.onError?.(conflict, e)
      showToast.error(e instanceof Error ? e.message : '저장 실패')
      window.dispatchEvent(
        new CustomEvent<OfficeSaveDoneDetail>('officeSaveDone', { detail: { ok: false, path: serverPath } }),
      )
      return false
    } finally {
      setSaving(false)
    }
  }, [serverPath, fileName, handle, saving, queryClient, onSaved, hooks])
  return { save, saving }
}
