import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { DocumentPreview } from '@/components/file-browser/DocumentPreview'
import AttachmentEditor from '@/components/file-browser/AttachmentEditor'
import { attachmentKindOf } from '@/components/file-browser/embedEdit'
import { baseNameOf, parseEditUrl } from '@/lib/editUrls'
import type { FileInfo } from '@/types/files'

/**
 * C5-4 (D64): URL 편집 페이지. 사이드바·탐색기·채팅을 렌더하지 않는다.
 * 타이틀바는 각 편집기가 갖고, Done이면 저장 후 탭을 닫는다.
 * 스크립트로 연 탭이 아니면 window.close()가 막히므로 "닫아도 됩니다" 화면을 대신 보여준다.
 */
export default function EditPage() {
  const { pathname } = useLocation()
  const parsed = useMemo(() => parseEditUrl(pathname), [pathname])
  const [closed, setClosed] = useState(false)

  useEffect(() => {
    setClosed(false)
  }, [pathname])

  const closeTab = (): void => {
    setClosed(true)
    try {
      window.close()
    } catch {
      /* 차단되면 아래 안내 화면이 남는다 */
    }
  }

  // StrictMode(개발/E2E)는 마운트→언마운트→리마운트를 돌려서 언마운트 cleanup이
  // onEditingChange(false)를 쏜다. 진짜 Done과 구분하려고 true→false 전이가
  // 1.5초 유지될 때만 닫는다 (리마운트는 수 ms 안에 true로 복귀해 취소된다).
  const latestEditingRef = useRef(true)
  const closeTimerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
    },
    [],
  )
  const handleEditingChange = useCallback((editing: boolean) => {
    latestEditingRef.current = editing
    if (editing) {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
      return
    }
    if (closeTimerRef.current !== null) return
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      if (!latestEditingRef.current) closeTab()
    }, 1500)
  }, [])

  useEffect(() => {
    if (!parsed) {
      document.title = '찾을 수 없음 — 편집'
      return
    }
    const name = parsed.kind === 'file' ? baseNameOf(parsed.path) : baseNameOf(parsed.part)
    document.title = `${name} — 편집`
  }, [parsed])

  if (!parsed) {
    return (
      <div data-testid="edit-404" className="h-screen w-screen flex items-center justify-center bg-background text-foreground">
        <div className="text-center">
          <div className="text-lg font-semibold">편집 주소를 해석할 수 없습니다</div>
          <div className="mt-1 text-sm text-muted-foreground">{pathname}</div>
        </div>
      </div>
    )
  }

  if (closed) {
    return (
      <div data-testid="edit-closed" className="h-screen w-screen flex items-center justify-center bg-background text-foreground">
        <div className="text-center">
          <div className="text-lg font-semibold">편집이 끝났습니다</div>
          <div className="mt-1 text-sm text-muted-foreground">이 탭을 닫아도 됩니다.</div>
        </div>
      </div>
    )
  }

  if (parsed.kind === 'attachment') {
    const name = baseNameOf(parsed.part)
    const kind = attachmentKindOf(name)
    if (!kind) {
      return (
        <div data-testid="edit-404" className="h-screen w-screen flex items-center justify-center bg-background text-foreground">
          <div className="text-center">
            <div className="text-lg font-semibold">이 첨부는 URL 편집을 지원하지 않습니다</div>
            <div className="mt-1 text-sm text-muted-foreground">{parsed.part}</div>
          </div>
        </div>
      )
    }
    return (
      <div data-testid="edit-page" className="h-screen w-screen overflow-hidden bg-background text-foreground">
        <AttachmentEditor
          target={{
            parentPath: parsed.parentPath,
            parentName: baseNameOf(parsed.parentPath),
            part: parsed.part,
            name,
            kind,
          }}
          onClose={closeTab}
        />
      </div>
    )
  }

  const file: FileInfo = {
    name: baseNameOf(parsed.path),
    path: parsed.path,
    isDirectory: false,
    size: 0,
    lastModified: new Date(),
  }
  return (
    <div data-testid="edit-page" className="h-screen w-screen overflow-hidden bg-background text-foreground">
      <DocumentPreview
        file={file}
        initialEditing
        editInNewTab={false}
        onEditingChange={handleEditingChange}
      />
    </div>
  )
}
