import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { translationsEn } from 'pptx-react-viewer/i18n'
import 'pptx-react-viewer/styles.css'
import { Button } from '@/components/ui/button'
import { saveOfficeBytes } from './officeSave'
import { showToast } from '@/lib/toast'
import { lazyWithRetry } from './lazyRetry'
import { loadPptxComments, loadPptxSlideSize, type PptxComment } from './pptxComments'
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
        .then(async (bytes) => {
          await saveOfficeBytes(
            savePath,
            fileName ?? 'presentation.pptx',
            new Blob([bytes as unknown as BlobPart], {
              type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            }),
          )
          // 저장된 바이트로 기준을 갱신한다 — 안 그러면 다음 코멘트 추가가 이전 내용을 덮는다.
          const fresh = new Uint8Array(bytes)
          setSavedBytes(fresh)
          const cs = await loadPptxComments(fresh)
          setComments(cs)
        })
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
  // lib에서 코멘트 추가 등 모델이 바뀌면 우리 목록도 다시 읽는다 (저장 전에도 보인다).
  const refreshComments = useCallback(async () => {
    const h = viewerRef.current
    if (!h) return
    try {
      const bytes = await h.getContent()
      const cs = await loadPptxComments(new Uint8Array(bytes))
      setComments(cs)
      if (cs.length > 0) setShowComments(true)
    } catch {
      /* 무시 */
    }
  }, [])
  const onViewerContentChange = useCallback(async () => {
    await refreshComments()
  }, [refreshComments])
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
  const [placing, setPlacing] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [slideSize, setSlideSize] = useState({ cx: 12192000, cy: 6858000 })
  const stageRef = useRef<HTMLDivElement>(null)
  // 슬라이드 클릭으로 코멘트 위치를 찍는다 (미리보기에서만).
  const onStageClickCapture = (e: React.MouseEvent) => {
    if (!placing || editing) return
    const stage = stageRef.current?.querySelector('main')
    if (!(stage instanceof HTMLElement)) return
    const r = stage.getBoundingClientRect()
    const cxPx = slideSize.cx / 9525
    const cyPx = slideSize.cy / 9525
    const scale = Math.min(r.width / cxPx, r.height / cyPx)
    const fw = cxPx * scale
    const fh = cyPx * scale
    const ox = r.left + (r.width - fw) / 2
    const oy = r.top + (r.height - fh) / 2
    const lx = e.clientX - ox
    const ly = e.clientY - oy
    if (lx < 0 || ly < 0 || lx > fw || ly > fh) return
    setPos({
      x: Math.round((lx / fw) * slideSize.cx),
      y: Math.round((ly / fh) * slideSize.cy),
    })
    setPlacing(false)
  }
  useEffect(() => {
    let dead = false
    void loadPptxSlideSize(content).then((s) => {
      if (!dead) setSlideSize(s)
    })
    return () => {
      dead = true
    }
  }, [content])
  useEffect(() => {
    setComments([])
    setShowComments(false)
    setSlideIdx(0)
    setCurSlide(0)
    setSavedBytes(null)
    setDraft('')
    setPos(null)
    setPlacing(false)
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
    // 작성자 통일을 위해 lib 기본값('You')과 맞춘다. 파일에 작성자가 1명이면 그걸 쓴다.
    const existingAuthors = [...new Set(comments.map((c) => c.author).filter((a) => a && a !== 'Unknown'))]
    const name = author.trim() || (existingAuthors.length === 1 ? existingAuthors[0] : 'You')
    setAdding(true)
    try {
      const target = curSlide + 1
      const next = await addPptxComment(content, {
        slideNo: target,
        authorName: name,
        text,
        pos: pos ?? undefined,
      })
      await saveOfficeBytes(
        savePath,
        fileName ?? 'presentation.pptx',
        new Blob([next as unknown as BlobPart], {
          type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        }),
      )
      setSavedBytes(next)
      setDraft('')
      setPos(null)
      setPlacing(false)
      setPlacing(false)
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
    <div
      ref={stageRef}
      onClickCapture={onStageClickCapture}
      className={`relative h-full min-h-[480px]${editing ? '' : ' pptx-preview-compact'}`}
    >
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
                  onContentChange={() => void onViewerContentChange()}
                />
              </I18nextProvider>
            </Suspense>
          </PptxViewerBoundary>
        </div>
        {showComments && (
          <div data-pptx-comments className="absolute right-2 top-2 bottom-2 w-72 z-30 border border-border bg-background flex flex-col rounded-lg shadow-xl">
            <div className="px-3 py-2 border-b border-border text-xs font-medium flex-shrink-0 flex items-center gap-1">
              <span className="flex-1">코멘트 ({comments.length})</span>
              <button
                type="button"
                onClick={() => void refreshComments()}
                className="inline-flex items-center justify-center h-6 w-6 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                title="다시 읽기"
              >
                <RefreshCw className="w-3 h-3" />
              </button>
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
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs flex-1"
                    onClick={() => {
                      setPos(null)
                      setPlacing((v) => !v)
                    }}
                  >
                    {placing ? '위치 클릭 대기 중…' : pos ? '위치 다시 찍기' : '📍 위치 찍기'}
                  </Button>
                </div>
                {pos && (
                  <p className="text-[11px] text-muted-foreground">
                    지정됨: {(pos.x / 914400).toFixed(1)}″, {(pos.y / 914400).toFixed(1)}″
                  </p>
                )}
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
