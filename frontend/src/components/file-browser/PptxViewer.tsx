import { Component, Suspense, lazy, useMemo, useRef, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import type { ViewerMode } from 'pptx-react-viewer'
import { translationsEn } from 'pptx-react-viewer/i18n'
import 'pptx-react-viewer/styles.css'
import { Button } from '@/components/ui/button'

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

const PPTX_RIBBON_TABS = [
  'file', 'home', 'insert', 'draw', 'design', 'transitions',
  'animations', 'slideShow', 'record', 'review', 'view', 'help',
] as const

const SPINNER = (
  <div className="flex items-center justify-center py-12">
    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
  </div>
)

function isEncryptedOle(data: Uint8Array): boolean {
  return data.length > 8 && data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0
}

export default function PptxViewer({ data, fileName, onFail }: { data: ArrayBuffer; fileName?: string; onFail: () => void }) {
  const content = useMemo(() => new Uint8Array(data.slice(0)), [data])
  const [editing, setEditing] = useState(false)
  const [unlocked, setUnlocked] = useState<Uint8Array | null>(null)
  const [pw, setPw] = useState('')
  const [pwError, setPwError] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)
  const prevMode = useRef<ViewerMode | null>(null)
  const customization = useMemo(
    () => ({ ribbon: { hiddenTabs: editing ? [] : [...PPTX_RIBBON_TABS] } }),
    [editing],
  )
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
    <div className="h-full min-h-[480px]">
      <PptxViewerBoundary onFail={onFail}>
        <Suspense fallback={SPINNER}>
          <I18nextProvider i18n={pptxI18n}>
            <PowerPointViewer
              content={unlocked ?? content}
              fileName={fileName}
              canEdit={false}
              customization={customization}
              onModeChange={(m) => {
                if (m === 'edit') {
                  setEditing(true)
                  if (prevMode.current === 'preview') {
                    window.dispatchEvent(new CustomEvent('fileFullscreenRequest', { detail: { isFullscreen: true } }))
                  }
                } else if (m === 'preview') {
                  setEditing(false)
                }
                prevMode.current = m
              }}
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
