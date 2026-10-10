import { useCallback, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { API_BASE_URL, OPENCODE_API_ENDPOINT } from '@/config'
import { createOpenCodeClient } from '@/api/opencode'
import { useEnqueueQueuedChat } from './useChatQueue'
import { detectDocKind } from '@/components/file-browser/DocumentPreview'
import { showToast } from '@/lib/toast'
import type { FileInfo } from '@/types/files'

/**
 * 파일 분석 (전용 하위세션 백그라운드 실행).
 * 추출 → (부모 있으면)하위세션 생성 → 모델 전송 → 완료 대기 → 분석 파일 저장.
 * 요소 코멘트→자동작업은 후속 단계 (분석 파일이 앵커가 된다).
 */
export interface FileAnalysisContext {
  /** 부모 세션 — 있으면 하위세션으로 분석, 없으면 일반 세션 생성 */
  sessionId?: string
  opcodeUrl?: string | null
  /** opencode 세션 생성용 디렉터리 (없으면 전역) */
  directory?: string
  repoId?: number
  /** 단독 탐색기에서: 분석 전달용 세션으로 이동 */
  onOpenSession?: (repoId: number | null, sessionId: string) => void
}

export type AnalysisPhase = 'idle' | 'extracting' | 'starting' | 'running' | 'saving' | 'done' | 'error'

const ANALYSIS_TIMEOUT_MS = 10 * 60_000
const POLL_MS = 2500
const MAX_INPUT_CHARS = 20000

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'tif'])

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

function isImageName(name: string): boolean {
  return IMAGE_EXTS.has(extOf(name))
}

function isTextName(mimeType?: string, name?: string): boolean {
  if (mimeType?.startsWith('text/')) return true
  if (mimeType && ['application/json', 'application/xml', 'text/javascript', 'text/typescript'].includes(mimeType)) return true
  return /\.(txt|md|markdown|json|xml|yml|yaml|toml|ini|cfg|log|csv|ts|tsx|js|jsx|py|go|rs|java|c|cpp|h|hpp|cs|rb|php|sh|ps1|sql|html|css|scss|vue|svelte)$/i.test(name ?? '')
}

function capText(s: string): string {
  if (s.length <= MAX_INPUT_CHARS) return s
  return `${s.slice(0, MAX_INPUT_CHARS)}\n…(생략, 전체 ${s.length.toLocaleString()}자)`
}

function decodeBase64(base64: string): string {
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return new TextDecoder('utf-8').decode(bytes)
}

interface OcrBox {
  text?: string
  left?: number
  top?: number
  width?: number
  height?: number
  conf?: number
}

async function extractAnalysisContent(file: FileInfo): Promise<{ kindLabel: string; content: string }> {
  const kind = detectDocKind(file.name)
  if (kind) {
    // office + pdf + msg — 단위 표기([Slide N]/[Sheet: ] 등)가 포함된 추출 텍스트
    const res = await fetch(`${API_BASE_URL}/api/preview/extract?path=${encodeURIComponent(file.path)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: file.path, refresh: false }),
    })
    if (!res.ok) throw new Error(`내용 추출 실패 (HTTP ${res.status})`)
    const json = (await res.json()) as { text?: string; ocr?: { text?: string; boxes?: OcrBox[] } }
    let content = (json.text ?? '').trim()
    const boxes = json.ocr?.boxes ?? []
    if (boxes.length > 0) {
      const lines = boxes.slice(0, 80).map((b) => `"${b.text ?? ''}" @(${b.left ?? 0},${b.top ?? 0},${b.width ?? 0}x${b.height ?? 0})`)
      content += `\n\n[이미지 내 텍스트 위치]\n${lines.join('\n')}`
      if (boxes.length > 80) content += `\n…(외 ${boxes.length - 80}개 생략)`
    }
    if (!content) throw new Error('추출된 내용이 없습니다')
    const label =
      kind === 'pptx' || kind === 'ppt'
        ? '프레젠테이션 (슬라이드 단위)'
        : kind === 'xlsx' || kind === 'xls'
          ? '스프레드시트 (시트 단위)'
          : kind === 'docx' || kind === 'doc'
            ? '문서'
            : kind === 'msg'
              ? '이메일'
              : 'PDF 문서'
    return { kindLabel: label, content: capText(content) }
  }
  if (isImageName(file.name)) {
    const res = await fetch(`${API_BASE_URL}/api/preview/extract?path=${encodeURIComponent(file.path)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: file.path, refresh: false }),
    })
    if (!res.ok) throw new Error(`내용 추출 실패 (HTTP ${res.status})`)
    const json = (await res.json()) as { text?: string; ocr?: { text?: string; boxes?: OcrBox[] } }
    const boxes = json.ocr?.boxes ?? []
    const ocrText = (json.ocr?.text ?? json.text ?? '').trim()
    if (!ocrText && boxes.length === 0) throw new Error('이미지에서 텍스트를 찾지 못했습니다 (OCR 비어 있음)')
    let content = `이미지 OCR 텍스트:\n${ocrText}`
    if (boxes.length > 0) {
      content += `\n\n요소 위치:\n${boxes
        .slice(0, 80)
        .map((b) => `"${b.text ?? ''}" @(${b.left ?? 0},${b.top ?? 0},${b.width ?? 0}x${b.height ?? 0})`)
        .join('\n')}`
    }
    return { kindLabel: '이미지 (OCR 텍스트 + 요소 좌표)', content: capText(content) }
  }
  if (isTextName(file.mimeType, file.name)) {
    let text = ''
    if (file.content) {
      text = decodeBase64(file.content)
    } else {
      const res = await fetch(`${API_BASE_URL}/api/files/${file.path}?raw=true`)
      if (!res.ok) throw new Error(`파일 읽기 실패 (HTTP ${res.status})`)
      text = await res.text()
    }
    if (!text.trim()) throw new Error('빈 파일입니다')
    return { kindLabel: '텍스트 파일', content: capText(text) }
  }
  throw new Error('분석 미지원 형식입니다 (office/텍스트/이미지만 가능)')
}

function buildAnalysisPrompt(fileName: string, kindLabel: string, content: string): string {
  return [
    `다음 ${kindLabel} 파일의 내용을 분석해줘. 파일명: ${fileName}`,
    ``,
    `--- 파일 내용 시작 ---`,
    content,
    `--- 파일 내용 끝 ---`,
    ``,
    `요구사항 (마크다운으로 답변):`,
    `1. 전체 의도/요약 (3-5줄)`,
    `2. 단위별 분석: ppt면 슬라이드별, 엑셀이면 시트별, 문서/텍스트면 섹션별로 각 단위가 무슨 의도인지와 핵심 내용`,
    `3. 요소 목록: 후속 자동작업에서 지칭할 수 있게 각 요소에 안정적인 참조 ID를 붙인다 (예: slide-3, sheet1!B12, para-7, img-2). 좌표가 있으면 함께 적는다`,
    `4. 후속 작업 제안 (짧게, 최대 5개)`,
  ].join('\n')
}

/** 원본 옆에 <base>.analysis.md 로 저장할 경로. */
export function pickAnalysisPath(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/')
  const slash = norm.lastIndexOf('/')
  const dir = slash >= 0 ? norm.slice(0, slash) : ''
  const base = (slash >= 0 ? norm.slice(slash + 1) : norm).replace(/\.[^.]+$/, '')
  const name = `${base || 'file'}.analysis.md`
  return dir ? `${dir}/${name}` : name
}

interface RecentMessage {
  info?: { id?: string; role?: string; time?: { created?: number; completed?: number } }
  parts?: Array<{ type?: string; text?: string }>
}

async function pollChildAnswer(childId: string, startedAt: number, alive: () => boolean): Promise<string> {
  const deadline = startedAt + ANALYSIS_TIMEOUT_MS
  for (;;) {
    if (!alive()) throw new Error('cancelled')
    if (Date.now() > deadline) throw new Error('분석 시간 초과 (10분)')
    await new Promise((r) => setTimeout(r, POLL_MS))
    if (!alive()) throw new Error('cancelled')
    let list: RecentMessage[] = []
    try {
      const res = await fetch(`${API_BASE_URL}/api/session-messages/${encodeURIComponent(childId)}/recent?limit=3`)
      if (!res.ok) continue
      const json = (await res.json()) as { messages?: RecentMessage[] }
      list = json.messages ?? []
    } catch {
      continue
    }
    const assistants = list.filter(
      (m) => m.info?.role === 'assistant' && (m.info?.time?.created ?? 0) >= startedAt - 5000,
    )
    const done = [...assistants]
      .reverse()
      .find((m) => m.info?.time?.completed && (m.parts ?? []).some((p) => p.type === 'text' && (p.text ?? '').trim()))
    if (done) {
      return (done.parts ?? [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('\n\n')
        .trim()
    }
  }
}

export function useFileAnalysis() {
  const queryClient = useQueryClient()
  const enqueue = useEnqueueQueuedChat()
  const [phase, setPhase] = useState<AnalysisPhase>('idle')
  const [progress, setProgress] = useState('')
  const [resultPath, setResultPath] = useState<string | null>(null)
  const [childId, setChildId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [passing, setPassing] = useState(false)
  const runIdRef = useRef(0)

  const cancel = useCallback(() => {
    runIdRef.current += 1
    setPhase('idle')
    setProgress('')
  }, [])

  const reset = useCallback(() => {
    runIdRef.current += 1
    setPhase('idle')
    setProgress('')
    setResultPath(null)
    setChildId(null)
    setError(null)
  }, [])

  const analyze = useCallback(
    async (
      file: FileInfo,
      model: { providerID: string; modelID: string } | null,
      ctx: FileAnalysisContext,
    ): Promise<string | null> => {
      const runId = ++runIdRef.current
      const alive = () => runIdRef.current === runId
      setError(null)
      setResultPath(null)
      setChildId(null)
      try {
        setPhase('extracting')
        setProgress('내용 추출 중…')
        const { kindLabel, content } = await extractAnalysisContent(file)
        if (!alive()) return null

        const opcodeUrl = ctx.opcodeUrl ?? OPENCODE_API_ENDPOINT
        const client = createOpenCodeClient(opcodeUrl, ctx.directory)
        setPhase('starting')
        setProgress('분석 세션 시작…')
        const title = `분석: ${file.name}`.slice(0, 60)
        const sess = (await client.createSession(
          ctx.sessionId ? { parentID: ctx.sessionId, title } : { title },
        )) as unknown as { id: string }
        const newChildId = sess.id
        if (!alive()) return null
        setChildId(newChildId)

        setPhase('running')
        setProgress('모델 분석 중…')
        await enqueue.mutateAsync({
          sessionID: newChildId,
          text: buildAnalysisPrompt(file.name, kindLabel, content),
          directory: ctx.directory || undefined,
          ...(model ? { model } : {}),
        })
        const answer = await pollChildAnswer(newChildId, Date.now(), alive)
        if (!alive() || !answer) return null

        setPhase('saving')
        setProgress('파일 저장 중…')
        const outPath = pickAnalysisPath(file.path)
        const header = `# 분석: ${file.name}\n\n- 원본: \`${file.path}\`\n- 일시: ${new Date().toLocaleString()}\n- 모델: ${model ? `${model.providerID}/${model.modelID}` : '기본값'}\n\n---\n\n`
        const putRes = await fetch(`${API_BASE_URL}/api/files/${outPath}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'file', content: header + answer }),
        })
        if (!putRes.ok) throw new Error(`분석 파일 저장 실패 (HTTP ${putRes.status})`)
        queryClient.invalidateQueries({ queryKey: ['files'] })
        queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions'] })
        if (!alive()) return null
        setResultPath(outPath)
        setPhase('done')
        setProgress('')
        showToast.success(`분석 저장됨: ${outPath}`)
        return outPath
      } catch (e) {
        if (!alive()) return null
        if ((e as Error)?.message === 'cancelled') {
          setPhase('idle')
          setProgress('')
          return null
        }
        setError(e instanceof Error ? e.message : '분석 실패')
        setPhase('error')
        setProgress('')
        return null
      }
    },
    [enqueue, queryClient],
  )

  const passToSession = useCallback(
    async (fileName: string, outPath: string | null, ctx: FileAnalysisContext): Promise<boolean> => {
      if (!outPath) return false
      setPassing(true)
      try {
        const opcodeUrl = ctx.opcodeUrl ?? OPENCODE_API_ENDPOINT
        const text = `@"${outPath}"\n\n위 분석 결과를 기준으로 이어서 작업해줘.`
        if (ctx.sessionId) {
          await enqueue.mutateAsync({ sessionID: ctx.sessionId, text, directory: ctx.directory || undefined })
          showToast.success('세션에 전달됨')
          return true
        }
        const client = createOpenCodeClient(opcodeUrl, ctx.directory)
        const sess = (await client.createSession({ title: `분석 기반 작업: ${fileName}`.slice(0, 60) })) as unknown as {
          id: string
        }
        await enqueue.mutateAsync({ sessionID: sess.id, text, directory: ctx.directory || undefined })
        ctx.onOpenSession?.(ctx.repoId ?? null, sess.id)
        showToast.success('새 세션에 전달됨')
        return true
      } catch (e) {
        showToast.error(e instanceof Error ? e.message : '전달 실패')
        return false
      } finally {
        setPassing(false)
      }
    },
    [enqueue],
  )

  return { phase, progress, resultPath, childId, error, passing, analyze, passToSession, cancel, reset }
}
