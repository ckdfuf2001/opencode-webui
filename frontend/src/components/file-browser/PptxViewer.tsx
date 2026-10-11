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
  const content = useMemo(() => new Uint8Array(data.slice(0)), [data])
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
  // 상단 코멘트 버튼: Comments 탭 토글 (켜져 있으면 Properties로 복귀).
  useEffect(() => {
    const onComments = () => {
      const wrap = wrapRef.current
      if (!wrap) return
      const tabs = Array.from(wrap.querySelectorAll('[role="tab"]')) as HTMLElement[]
      if (!tabs.length) {
        showToast.info('우측 패널이 닫혀 있어 코멘트를 열 수 없습니다')
        return
      }
      const comments = tabs.find((t) => /comment/i.test(t.textContent ?? ''))
      if (!comments) return
      const isOpen = (t: HTMLElement) =>
        t.getAttribute('aria-selected') === 'true' || (t.dataset?.state ?? '') === 'active'
      if (isOpen(comments)) {
        const back =
          tabs.find((t) => t !== comments && /propert/i.test(t.textContent ?? '')) ??
          tabs.find((t) => t !== comments)
        back?.click()
      } else {
        comments.click()
      }
    }
    window.addEventListener('pptxCommentsRequest', onComments)
    return () => window.removeEventListener('pptxCommentsRequest', onComments)
  }, [])
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
      // 미리보기창 남는 폭을 썸네일이 다 채운다 (우측 패널·스플리터 제외).
      const panel = wrap.querySelector('[role="complementary"]') as HTMLElement | null
      const panelW = panel ? panel.getBoundingClientRect().width : 0
      let sepsW = 0
      wrap.querySelectorAll('[role="separator"]').forEach((s) => {
        const r = (s as HTMLElement).getBoundingClientRect()
        if (r.width > 0) sepsW += r.width
      })
      const w = Math.max(200, Math.round(wrap.clientWidth - panelW - sepsW - 4))
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
      <PptxViewerBoundary onFail={onFail}>
        <Suspense fallback={SPINNER}>
          <I18nextProvider i18n={pptxI18n}>
            <PowerPointViewer
              key={editing ? 'edit' : 'view'}
              ref={setViewerRef}
              content={unlocked ?? content}
              fileName={fileName}
              canEdit={editing}
              showToolbar={editing}
            />
          </I18nextProvider>
        </Suspense>
      </PptxViewerBoundary>
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
