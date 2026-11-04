import { useCallback, useEffect, useMemo, useState } from 'react'
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
  const { pathname, search } = useLocation()
  const parsed = useMemo(() => parseEditUrl(pathname), [pathname])
  // U-stale: ?partHash= 로 열린 딥링크면 로드 뒤 파트 해시와 대조한다.
  const expectedPartHash = useMemo(() => {
    try {
      const h = new URLSearchParams(search ?? '').get('partHash')
      return h && h.length > 0 ? h : null
    } catch {
      return null
    }
  }, [search])
  const [closed, setClosed] = useState(false)
  // C5-4: 편집 페이지는 마운트 시점부터 편집 모드다 (in-place 전환 없음).

  useEffect(() => {
    setClosed(false)
  }, [pathname])

  // P0-2: Done은 명시적 onDone으로만 닫는다 (언마운트 cleanup의 false 추정은 쓰지 않는다).
  const closeTab = useCallback((): void => {
    setClosed(true)
    try {
      window.close()
    } catch {
      /* 차단되면 아래 안내 화면이 남는다 */
    }
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
        expectedPartHash={expectedPartHash}
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
  // C5-4c A1: 예전 전체화면 컨테이너와 같은 구조 (FilePreview isFullscreen +
  // h-full p-2). fixed 루트 + 패딩 래퍼 — 리본 수치가 예전과 같아진다.
  return (
    <div data-testid="edit-page" className="fixed inset-0 z-[100] bg-background flex flex-col text-foreground">
      <div className="flex-1 h-full p-2 min-w-0 min-h-0 overflow-hidden">
        <DocumentPreview file={file} initialEditing editInNewTab={false} onDone={closeTab} />
      </div>
    </div>
  )
}
