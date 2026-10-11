import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { translationsEn } from 'pptx-react-viewer/i18n'
import 'pptx-react-viewer/styles.css'
import { Button } from '@/components/ui/button'
import { saveOfficeBytes } from './officeSave'
import { showToast } from '@/lib/toast'
import { lazyWithRetry } from './lazyRetry'
import { loadPptxComments, type PptxComment } from './pptxComments'
import { addPptxComment } from './pptxCommentWriter'

const PowerPointViewer = lazyWithRetry(() =>
  import('pptx-react-viewer').then((m) => ({ default: m.PowerPointViewer })),
)

const pptxI18n = createInstance()
void pptxI18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: translationsEn } },
  interpolation: { escapeValue: false },
})

const SPINNER = (
  <div className="flex items-center justify-center py-12">
    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
  </div>
)

function isEncryptedOle(data: Uint8Array): boolean {
  return data.length > 8 && data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0
}

export default function PptxViewer({ data, fileName, editing, savePath, onFail }: { data: ArrayBuffer; fileName?: string; editing: boolean; savePath?: string; onFail: () => void }) {
  const baseContent = useMemo(() => new Uint8Array(data.slice(0)), [data])
  const [savedBytes, setSavedBytes] = useState<Uint8Array | null>(null)
  const content = savedBytes ?? baseContent
  const [unlocked, setUnlocked] = useState<Uint8Array | null>(null)
  const viewerRef = useRef<{ getContent: () => Promise<Uint8Array> } | null>(null)
  const setViewerRef = useCallback(
    (h: { getContent: () => Promise<Uint8Array> } | null) => {
      viewerRef.current = h
    },
    [],
  )
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    const onSave = () => {
      if (saving) return
      const h = viewerRef.current
      if (!h || !savePath) return
      setSaving(true)
      void h
        .getContent()
        .then((bytes) =>
          saveOfficeBytes(
            savePath,
            fileName ?? 'presentation.pptx',
            new Blob([bytes as unknown as BlobPart], {
              type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            }),
          ),
        )
        .then(() => {
          showToast.success('저장했습니다')
          window.dispatchEvent(new CustomEvent('officeSaveDone', { detail: { ok: true } }))
        })
        .catch((e) => {
          showToast.error(e instanceof Error ? e.message : '저장 실패')
          window.dispatchEvent(new CustomEvent('officeSaveDone', { detail: { ok: false } }))
        })
        .finally(() => setSaving(false))
    }
    window.addEventListener('officeSaveRequest', onSave)
    return () => window.removeEventListener('officeSaveRequest', onSave)
  }, [savePath, fileName, saving])
  // 상단 코멘트 버튼: 우측 우리 목록 패널을 여닫는다 (docx/xlsx와 통일).
  const [comments, setComments] = useState<PptxComment[]>([])
  const [showComments, setShowComments] = useState(false)
  const [slideIdx, setSlideIdx] = useState(0)
  const [curSlide, setCurSlide] = useState(0)
  const [reloadKey, setReloadKey] = useState(0)
  const [author, setAuthor] = useState(() => {
    try {
      return localStorage.getItem('ppt-comment-author') ?? ''
    } catch {
      return ''
    }
  })
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  useEffect(() => {
    setComments([])
    setShowComments(false)
    setSlideIdx(0)
    setCurSlide(0)
    setSavedBytes(null)
    setDraft('')
  }, [data])
  useEffect(() => {
    let dead = false
    void loadPptxComments(content).then((cs) => {
      if (dead) return
      setComments(cs)
      if (cs.length > 0) setShowComments(true)
    })
    return () => {
      dead = true
    }
  }, [content])
  useEffect(() => {
    const onComments = () => {
      setShowComments((v) => !v)
    }
    window.addEventListener('pptxCommentsRequest', onComments)
    return () => window.removeEventListener('pptxCommentsRequest', onComments)
  }, [])
  const openComment = (c: PptxComment) => {
    if (editing) {
      showToast.info('편집 중에는 슬라이드 이동을 하지 않습니다')
      return
    }
    const idx = Math.max(0, c.slideNo - 1)
    setSlideIdx(idx)
    setCurSlide(idx)
  }
  const addComment = async () => {
    const text = draft.trim()
    if (!text || adding) return
    if (!savePath) {
      showToast.error('저장 경로가 없습니다')
      return
    }
    const existingAuthors = [...new Set(comments.map((c) => c.author).filter((a) => a && a !== 'Unknown'))]
    const name = author.trim() || (existingAuthors.length === 1 ? existingAuthors[0] : 'Me')
    setAdding(true)
    try {
      const target = curSlide + 1
      const next = await addPptxComment(content, { slideNo: target, authorName: name, text })
      await saveOfficeBytes(
        savePath,
        fileName ?? 'presentation.pptx',
        new Blob([next as unknown as BlobPart], {
          type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        }),
      )
      setSavedBytes(next)
      setDraft('')
      try {
        localStorage.setItem('ppt-comment-author', name)
      } catch {
        /* 무시 */
      }
      const cs = await loadPptxComments(next)
      setComments(cs)
      if (cs.length > 0) setShowComments(true)
      setSlideIdx(target - 1)
      setCurSlide(target - 1)
      setReloadKey((v) => v + 1)
      showToast.success('코멘트 저장했습니다')
    } catch (e) {
      showToast.error(e instanceof Error ? e.message : '코멘트 저장 실패')
    } finally {
      setAdding(false)
    }
  }
  const [pw, setPw] = useState('')
  const [pwError, setPwError] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)
  const unlock = async () => {
    if (!pw || unlocking) return
    setUnlocking(true)
    setPwError(null)
    try {
      const { decryptPptx } = await import('ooxml-core/pptx')
      const dec = await decryptPptx(content.buffer as ArrayBuffer, pw)
      setUnlocked(new Uint8Array(dec))
    } catch (e) {
      setPwError(e instanceof Error ? e.message : 'Failed to decrypt')
    } finally {
      setUnlocking(false)
    }
  }
  const wrapRef = useRef<HTMLDivElement>(null)
  const userSizedRef = useRef(false)
  useEffect(() => { userSizedRef.current = false }, [data])
  useEffect(() => {
    if (editing) return
    const wrap = wrapRef.current
    if (!wrap) return
    const fitThumbs = () => {
      if (userSizedRef.current) return
      const aside = wrap.querySelector('aside')
      if (!(aside instanceof HTMLElement)) return
      // 미리보기창 남는 폭을 썸네일이 다 채운다 (우측 패널·코멘트·스플리터 제외).
      const panel = wrap.querySelector('[role="complementary"]') as HTMLElement | null
      const panelW = panel ? panel.getBoundingClientRect().width : 0
      const ours = wrap.querySelector('[data-pptx-comments]') as HTMLElement | null
      const oursW = ours ? ours.getBoundingClientRect().width : 0
      let sepsW = 0
      wrap.querySelectorAll('[role="separator"]').forEach((s) => {
        const r = (s as HTMLElement).getBoundingClientRect()
        if (r.width > 0) sepsW += r.width
      })
      const w = Math.max(200, Math.round(wrap.clientWidth - panelW - oursW - sepsW - 4))
      // 라이브러리가 렌더 때마다 되돌려서 RO로 감시 + 다를 때만 쓴다 (루프 방지).
      if (Math.abs(aside.getBoundingClientRect().width - w) > 1) aside.style.width = `${w}px`
    }
    const onPointerDown = (e: Event) => {
      if ((e.target as HTMLElement).closest?.('[role="separator"]')) userSizedRef.current = true
    }
    wrap.addEventListener('pointerdown', onPointerDown)
    fitThumbs()
    const ro = new ResizeObserver(fitThumbs)
    ro.observe(wrap)
    // aside 자체 리사이즈(라이브러리 되돌림·슬라이드 전환)에도 맞춘다.
    const asideRO = new ResizeObserver(fitThumbs)
    // 뷰어는 lazy 마운트라 aside가 늦게 생긴다. 생기면 맞추고 감시 붙인다.
    const mo = new MutationObserver(() => {
      const aside = wrap.querySelector('aside')
      if (aside instanceof HTMLElement) {
        fitThumbs()
        asideRO.observe(aside)
        mo.disconnect()
      }
    })
    mo.observe(wrap, { childList: true, subtree: true })
    return () => {
      mo.disconnect()
      ro.disconnect()
      asideRO.disconnect()
      wrap.removeEventListener('pointerdown', onPointerDown)
    }
  }, [editing, data])
  if (!unlocked && isEncryptedOle(content)) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center px-6 gap-3">
        <p className="text-sm text-foreground font-medium">암호로 보호된 파일입니다</p>
        <p className="text-xs text-muted-foreground">열람용 암호를 입력하세요 (사내 DRM 문서는 열 수 없습니다)</p>
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void unlock() }}
          placeholder="암호"
          className="h-8 w-56 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        {pwError && <p className="text-xs text-destructive">{pwError}</p>}
        <Button size="sm" onClick={() => void unlock()} disabled={!pw || unlocking}>
          {unlocking ? '여는 중…' : '열기'}
        </Button>
      </div>
    )
  }
  return (
    <div ref={wrapRef} className={`h-full min-h-[480px]${editing ? '' : ' pptx-preview-compact'}`}>
      <div className="flex h-full min-h-0">
        <div className="flex-1 min-w-0 h-full">
          <PptxViewerBoundary onFail={onFail}>
            <Suspense fallback={SPINNER}>
              <I18nextProvider i18n={pptxI18n}>
                <PowerPointViewer
                  key={`${editing ? 'edit' : 'view'}#${slideIdx}#${reloadKey}`}
                  ref={setViewerRef}
                  content={unlocked ?? content}
                  fileName={fileName}
                  canEdit={editing}
                  showToolbar={editing}
                  initialSlide={slideIdx}
                  onActiveSlideChange={(i: number) => setCurSlide(i)}
                />
              </I18nextProvider>
            </Suspense>
          </PptxViewerBoundary>
        </div>
        {showComments && (
          <div data-pptx-comments className="w-72 shrink-0 border-l border-border bg-background flex flex-col min-h-0">
            <div className="px-3 py-2 border-b border-border text-xs font-medium flex-shrink-0">
              코멘트 ({comments.length})
            </div>
            {!editing && (
              <div className="p-2 border-b border-border flex-shrink-0 space-y-1.5">
                <input
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  placeholder="이름"
                  className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs outline-none"
                />
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={`코멘트 입력 (슬라이드 ${curSlide + 1})`}
                  rows={2}
                  className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none resize-none"
                />
                <Button
                  size="sm"
                  className="w-full h-7 text-xs"
                  disabled={!draft.trim() || adding}
                  onClick={() => void addComment()}
                >
                  {adding ? '저장 중…' : '코멘트 저장'}
                </Button>
              </div>
            )}
            <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
              {comments.length === 0 && (
                <p className="text-xs text-muted-foreground px-1">코멘트 없음</p>
              )}
              {comments.map((c, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => openComment(c)}
                  className="w-full text-left rounded-md border border-border/60 p-2 hover:bg-muted/60 transition-colors"
                  title={`${c.slideNo}번 슬라이드로 이동`}
                >
                  <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <span className="shrink-0 font-mono">슬라이드 {c.slideNo}</span>
                  </div>
                  <div className="text-xs font-medium mt-0.5">{c.author}</div>
                  <div className="text-xs whitespace-pre-wrap break-words mt-0.5">{c.text}</div>
                  {c.replies.map((r, j) => (
                    <div key={j} className="mt-1.5 pl-2 border-l-2 border-border">
                      <div className="text-xs font-medium">{r.author}</div>
                      <div className="text-xs whitespace-pre-wrap break-words">{r.text}</div>
                    </div>
                  ))}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

class PptxViewerBoundary extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidCatch(): void {
    this.props.onFail()
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}
