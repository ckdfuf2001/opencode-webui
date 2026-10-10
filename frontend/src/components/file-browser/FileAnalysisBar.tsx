import { useEffect, useMemo, useState } from 'react'
import { Loader2, ScanSearch, Send, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getProvidersWithModels, type ProviderWithModels } from '@/api/providers'
import { useFileAnalysis, type FileAnalysisContext } from '@/hooks/useFileAnalysis'
import type { FileInfo } from '@/types/files'

/**
 * 탐색기 하단 분석바 — 모델 선택 + 분석 실행 + 세션 전달.
 * 분석은 전용 하위세션(부모 있으면 자식, 없으면 일반)에서 백그라운드로 돌고
 * 결과는 원본 옆 .analysis.md 파일로 저장된다.
 */
export function FileAnalysisBar({ file, context }: { file: FileInfo | null; context: FileAnalysisContext }) {
  const [providers, setProviders] = useState<ProviderWithModels[]>([])
  const [modelKey, setModelKey] = useState('')
  const { phase, progress, resultPath, error, passing, analyze, passToSession, cancel } = useFileAnalysis()

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const list = await getProvidersWithModels()
        if (!live) return
        const nonEmpty = list.filter((p) => p.models.length > 0)
        setProviders(nonEmpty)
        // 기본값: 저장된 기본 모델 → 첫 번째
        let initial = ''
        try {
          initial = localStorage.getItem('opencode-default-model') ?? ''
        } catch {}
        const flat = nonEmpty.flatMap((p) => p.models.map((m) => `${p.id}/${m.id}`))
        if (!flat.includes(initial)) initial = flat[0] ?? ''
        setModelKey(initial)
      } catch {
        /* 모델 목록 실패 — 분석 버튼 비활성화 */
      }
    })()
    return () => {
      live = false
    }
  }, [])

  const running = phase === 'extracting' || phase === 'starting' || phase === 'running' || phase === 'saving'

  const model = useMemo(() => {
    const slash = modelKey.indexOf('/')
    if (slash <= 0) return null
    return { providerID: modelKey.slice(0, slash), modelID: modelKey.slice(slash + 1) }
  }, [modelKey])

  const canAnalyze = !!file && !file.isDirectory && !running && providers.length > 0 && !!model

  return (
    <div className="flex-shrink-0 border-t border-border bg-background px-3 py-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0" title="파일 내용 분석">
          <ScanSearch className="w-3.5 h-3.5" />
          분석
        </span>
        <select
          value={modelKey}
          onChange={(e) => setModelKey(e.target.value)}
          disabled={running || providers.length === 0}
          className="h-7 max-w-[220px] truncate text-xs bg-background border border-border rounded px-1.5 outline-none disabled:opacity-50"
          title="분석 모델"
        >
          {providers.length === 0 && <option value="">모델 없음</option>}
          {providers.map((p) => (
            <optgroup key={p.id} label={p.name || p.id}>
              {p.models.map((m) => (
                <option key={`${p.id}/${m.id}`} value={`${p.id}/${m.id}`}>
                  {m.name || m.id}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {!running ? (
          <Button
            size="sm"
            className="h-7 text-xs px-2.5"
            disabled={!canAnalyze}
            title={file ? (file.isDirectory ? '파일을 선택하세요 (폴더 제외)' : `${file.name} 분석`) : '파일을 먼저 선택하세요'}
            onClick={() => {
              if (file) void analyze(file, model, context)
            }}
          >
            {phase === 'done' ? '다시 분석' : '분석'}
          </Button>
        ) : (
          <Button size="sm" variant="outline" className="h-7 text-xs px-2.5" onClick={cancel} title="분석 중단">
            <X className="w-3 h-3 mr-1" />
            중단
          </Button>
        )}
        {running && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
            <Loader2 className="w-3 h-3 animate-spin shrink-0" />
            <span className="truncate">{progress || '진행 중…'}</span>
          </span>
        )}
        {phase === 'error' && error && <span className="text-xs text-destructive truncate" title={error}>{error}</span>}
        {phase === 'done' && resultPath && (
          <span className="inline-flex items-center gap-2 min-w-0">
            <span className="text-xs text-muted-foreground truncate" title={resultPath}>
              저장됨: {resultPath.split('/').pop()}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs px-2 shrink-0"
              disabled={passing}
              title={context.sessionId ? '왼쪽 세션 채팅에 분석 파일 전달' : '새 세션을 만들어 분석 파일 전달'}
              onClick={async () => {
                if (!file) return
                await passToSession(file.name, resultPath, context)
              }}
            >
              {passing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
              <span className="ml-1">세션에 전달</span>
            </Button>
          </span>
        )}
        {!file && phase === 'idle' && (
          <span className="text-[11px] text-muted-foreground">파일을 선택하면 분석할 수 있습니다</span>
        )}
      </div>
    </div>
  )
}
