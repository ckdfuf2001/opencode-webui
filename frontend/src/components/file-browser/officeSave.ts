import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { API_BASE_URL } from '@/config'
import { showToast } from '@/lib/toast'

/** 미리보기 편집 저장: 같은 자리에 덮어쓴다 (새 파일로 다운 아님). */
export async function saveOfficeBytes(serverPath: string, fileName: string, blob: Blob): Promise<void> {
  const fd = new FormData()
  fd.append('file', new File([blob], fileName, { type: blob.type || 'application/octet-stream' }))
  const res = await fetch(`${API_BASE_URL}/api/files/${serverPath}?overwrite=1`, {
    method: 'POST',
    body: fd,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error || `Save failed (${res.status})`)
  }
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
 */
export function useOfficeSave(
  serverPath: string,
  fileName: string,
  handle: SaveHandle,
  onSaved?: (bytes: Uint8Array) => void,
) {
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const save = useCallback(async (): Promise<boolean> => {
    if (!handle || saving) return false
    setSaving(true)
    try {
      const blob = await handle.save()
      await saveOfficeBytes(serverPath, fileName, blob)
      handle.markClean()
      try {
        onSaved?.(new Uint8Array(await blob.arrayBuffer()))
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
      showToast.error(e instanceof Error ? e.message : '저장 실패')
      window.dispatchEvent(
        new CustomEvent<OfficeSaveDoneDetail>('officeSaveDone', { detail: { ok: false, path: serverPath } }),
      )
      return false
    } finally {
      setSaving(false)
    }
  }, [serverPath, fileName, handle, saving, queryClient, onSaved])
  return { save, saving }
}
