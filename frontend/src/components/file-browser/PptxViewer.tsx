import { Component, Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { translationsEn } from 'pptx-react-viewer/i18n'
import 'pptx-react-viewer/styles.css'
import { Button } from '@/components/ui/button'
import { saveOfficeBytes } from './officeSave'
import { showToast } from '@/lib/toast'

const PowerPointViewer = lazy(() =>
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
        .then(() => showToast.success('저장했습니다'))
        .catch((e) => showToast.error(e instanceof Error ? e.message : '저장 실패'))
        .finally(() => setSaving(false))
    }
    window.addEventListener('officeSaveRequest', onSave)
    return () => window.removeEventListener('officeSaveRequest', onSave)
  }, [savePath, fileName, saving])
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
      const w = Math.round(Math.min(300, Math.max(160, wrap.clientWidth * 0.16)))
      aside.style.width = `${w}px`
    }
    const onPointerDown = (e: Event) => {
      if ((e.target as HTMLElement).closest?.('[role="separator"]')) userSizedRef.current = true
    }
    wrap.addEventListener('pointerdown', onPointerDown)
    fitThumbs()
    // 뷰어는 lazy 마운트라 aside가 늦게 생긴다. 생기면 한 번 맞춘다.
    const mo = new MutationObserver(() => {
      if (wrap.querySelector('aside')) {
        fitThumbs()
        mo.disconnect()
      }
    })
    mo.observe(wrap, { childList: true, subtree: true })
    const ro = new ResizeObserver(fitThumbs)
    ro.observe(wrap)
    return () => {
      mo.disconnect()
      ro.disconnect()
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
              ref={(h) => {
                viewerRef.current = h
              }}
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
