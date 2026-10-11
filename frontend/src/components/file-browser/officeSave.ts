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
 * 뷰어 툴바 저장 가로채기 + 상단 저장 버튼 공용.
 * handle이 없거나 저장 중이면 false.
 */
export function useOfficeSave(serverPath: string, fileName: string, handle: SaveHandle) {
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const save = useCallback(async (): Promise<boolean> => {
    if (!handle || saving) return false
    setSaving(true)
    try {
      const blob = await handle.save()
      await saveOfficeBytes(serverPath, fileName, blob)
      handle.markClean()
      void queryClient.invalidateQueries({ queryKey: ['files'] })
      showToast.success('저장했습니다')
      return true
    } catch (e) {
      showToast.error(e instanceof Error ? e.message : '저장 실패')
      return false
    } finally {
      setSaving(false)
    }
  }, [serverPath, fileName, handle, saving, queryClient])
  return { save, saving }
}
