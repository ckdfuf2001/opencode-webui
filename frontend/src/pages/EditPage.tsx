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
  const { pathname } = useLocation()
  const parsed = useMemo(() => parseEditUrl(pathname), [pathname])
  const [closed, setClosed] = useState(false)
  // C5-4: PPTX는 viewer로 먼저 마운트한 뒤 편집으로 전환한다.
  // 직접 edit 마운트는 시딩이 안 되고(E17), 전환이 너무 이르면 lib write-back
  // 스케줄이 묶여 타이핑이 디스크에 안 남는다(E2). viewer가 붙고 lib이
  // settle한 뒤 전환한다: connected + 3초 여유 (정확한 ready 신호는 백로그).
  const isPptxHost = parsed?.kind === 'file' && parsed.path.toLowerCase().endsWith('.pptx')
  const [editSignal, setEditSignal] = useState(0)
  useEffect(() => {
    if (!isPptxHost || closed) return
    let dead = false
    const t0 = Date.now()
    const timer = window.setInterval(() => {
      if (dead) return
      const el = document.querySelector('[data-testid="collab-status"]')
      if ((el?.getAttribute('data-status') === 'connected' && Date.now() - t0 > 3000) || Date.now() - t0 > 30000) {
        window.clearInterval(timer)
        if (!dead) setEditSignal((s) => s + 1)
      }
    }, 500)
    return () => {
      dead = true
      window.clearInterval(timer)
    }
  }, [pathname, parsed, isPptxHost, closed])

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
      <DocumentPreview file={file} initialEditing={!isPptxHost} editSignal={editSignal} editInNewTab={false} onDone={closeTab} />
    </div>
  )
}
