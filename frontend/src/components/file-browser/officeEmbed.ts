import { API_BASE_URL } from '@/config'
import { showToast } from '@/lib/toast'

/**
 * C5-2: INSERT 문서 첨부 — 클라이언트 플로우.
 * 헤더 "문서 첨부" 버튼 → 파일 선택(officeEmbedFile 이벤트) →
 * 마운트된 뷰어가 자기 방 컨텍스트로 POST → 200이면 reload.
 * - 편집 중이면 먼저 저장한다 (방/단독 공통 officeSaveRequest 경로).
 * - 409 dirty_room이면 저장 후 1회만 재시도한다.
 * - viewer는 서버가 403으로 막는다 (클라이언트도 미리 막는다).
 */

export const OFFICE_EMBED_REQUEST = 'officeEmbedRequest'
export const OFFICE_EMBED_FILE = 'officeEmbedFile'
export const OFFICE_EMBED_DONE = 'officeEmbedDone'
/** 4001 리셋 후 새 바이트를 먼저 받아오라는 요청 (stale 호스팅 방지). */
export const OFFICE_RESET_RELOAD = 'officeResetReload'

export interface EmbedDetail {
  file: File
  hostPath: string
}

export interface EmbedCtx {
  hostPath: string
  kind: 'pptx' | 'xlsx' | 'docx'
  roomId?: string
  clientId?: number
  getBaseHash?: () => string | undefined
  slide?: number
  /** xlsx 0-based 시트 (기본 0). */
  sheet?: number
  isViewer?: boolean
  saveFirst: () => Promise<boolean>
  reload: () => void
}

function waitSaveDone(path: string, timeoutMs = 30000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        window.removeEventListener('officeSaveDone', onDone)
        resolve(false)
      }
    }, timeoutMs)
    const onDone = (e: Event): void => {
      const d = (e as CustomEvent<{ ok?: boolean; path?: string }>).detail
      if (d?.path !== undefined && d.path !== path) return
      if (!done) {
        done = true
        clearTimeout(timer)
        window.removeEventListener('officeSaveDone', onDone)
        resolve(d?.ok === true)
      }
    }
    window.addEventListener('officeSaveDone', onDone)
    window.dispatchEvent(new CustomEvent('officeSaveRequest'))
  })
}

/** 편집 중이면 저장부터 한다 (실패하면 첨부를 중단한다). */
export async function saveBeforeEmbed(hostPath: string, editing: boolean): Promise<boolean> {
  if (!editing) return true
  return waitSaveDone(hostPath)
}

async function postEmbed(fd: FormData): Promise<{ status: number; body: { code?: string; error?: string } }> {
  const res = await fetch(`${API_BASE_URL}/api/collab/embed`, { method: 'POST', body: fd })
  const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string }
  return { status: res.status, body }
}

export async function runOfficeEmbed(file: File, ctx: EmbedCtx): Promise<void> {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase()
  if (!['docx', 'xlsx', 'pptx'].includes(ext)) {
    showToast.error('docx/xlsx/pptx 파일만 첨부할 수 있습니다')
    return
  }
  // viewer 여부는 서버가 최종 판정한다 (편집자 없는 solo 보기는 허용).
  // isViewer는 호환용으로 남긴다.
  const doPost = async (): Promise<{ status: number; body: { code?: string; error?: string } }> => {
    const fd = new FormData()
    fd.append('path', ctx.hostPath)
    fd.append('file', file, file.name)
    if (ctx.slide != null) fd.append('slide', String(ctx.slide))
    if (ctx.sheet != null) fd.append('sheet', String(ctx.sheet))
    if (ctx.roomId) fd.append('roomId', ctx.roomId)
    if (ctx.clientId !== undefined) fd.append('clientId', String(ctx.clientId))
    const baseHash = ctx.getBaseHash?.()
    if (baseHash) fd.append('baseHash', baseHash)
    return postEmbed(fd)
  }
  const ok = await ctx.saveFirst()
  if (!ok) {
    showToast.error('저장에 실패해 첨부를 중단합니다')
    return
  }
  let r = await doPost()
  if (r.status === 409 && r.body.code === 'dirty_room') {
    // 방이 바뀌었으면 저장 후 1회만 재시도한다.
    const ok2 = await ctx.saveFirst()
    if (!ok2) {
      showToast.error('저장에 실패해 첨부를 중단합니다')
      return
    }
    r = await doPost()
  }
  if (r.status === 200) {
    showToast.success('문서를 첨부했습니다')
    window.dispatchEvent(new CustomEvent(OFFICE_EMBED_DONE, { detail: { path: ctx.hostPath } }))
    ctx.reload()
    return
  }
  if (r.status === 403) {
    showToast.error('보기 모드에서는 첨부할 수 없습니다')
    return
  }
  showToast.error(r.body.error || `첨부 실패 (${r.status})`)
}
