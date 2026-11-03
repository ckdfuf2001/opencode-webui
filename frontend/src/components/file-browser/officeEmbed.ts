import { API_BASE_URL } from '@/config'
import { showToast } from '@/lib/toast'
import type { RibbonAddInTab } from 'ooxml-core/ribbon'
import type { OfficeSaveRequestDetail } from './officeSave'

/**
 * C5-2: INSERT 문서 첨부 — 클라이언트 플로우.
 * 리본 "첨부" 탭(공식 ribbonAddIns) → 파일 선택(officeEmbedRequest →
 * 숨은 input 클릭 → officeEmbedFile 이벤트) → 마운트된 뷰어가 자기 방
 * 컨텍스트로 POST → 200이면 reload. 보기 모드(리본 없음)에서는 헤더 버튼 유지.
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

/** C5-2 add-in 탭: 파일 선택을 요청한다 (숨은 input을 가진 호스트가 받아 클릭한다). */
export interface EmbedRequestDetail {
  hostPath: string
}

export function requestEmbedFile(hostPath: string): void {
  window.dispatchEvent(new CustomEvent<EmbedRequestDetail>(OFFICE_EMBED_REQUEST, { detail: { hostPath } }))
}

/**
 * C5-2 add-in 탭: lib 공식 확장점(`ribbonAddIns`)용 "첨부" 탭 기술자.
 * lib가 built-in 탭 교체를 금지하므로(acceptedRibbonAddIns) Help 뒤에 새 탭으로
 * 붙는다 (Office의 ACROBAT 탭과 같은 방식). PPTX/XLSX/DOCX 공통.
 */
export const OFFICE_ATTACH_TAB_ID = 'attach'
export const OFFICE_ATTACH_COMMAND_ID = 'attach-document'

export function buildOfficeAttachAddIn(onPick: () => void): RibbonAddInTab[] {
  return [
    {
      id: OFFICE_ATTACH_TAB_ID,
      label: '첨부',
      groups: [
        {
          label: '문서',
          commands: [
            {
              id: OFFICE_ATTACH_COMMAND_ID,
              label: '문서 첨부',
              title: '문서 첨부 (docx/xlsx/pptx)',
              run: onPick,
            },
          ],
        },
      ],
    },
  ]
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
  /** 방 미시드(not_seeded)로 선저장이 실패하면 시드를 기다렸다가 1회 재시도한다. 없으면 즉시 중단. */
  waitSeed?: () => Promise<boolean>
  reload: () => void
}

/** 방 시드를 최대 timeoutMs까지 기다린다 (setTimeout 체인, 상시 타이머 없음). */
export function waitCollabSeed(isSeeded: () => boolean, timeoutMs = 30000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now()
    const tick = (): void => {
      let ok = false
      try {
        ok = isSeeded()
      } catch {
        ok = false
      }
      if (ok || Date.now() - start >= timeoutMs) {
        resolve(ok)
        return
      }
      setTimeout(tick, 500)
    }
    tick()
  })
}

/**
 * 서버 방의 시드 여부. 방이 없거나 조회 실패면 null.
 * (시드는 originated 업데이트 때만 생긴다 — collab-rooms.ts. unseeded면
 * 로컬에 플러시할 내용이 없으므로 임베드 POST를 디스크 기준으로 진행해도 안전하다.)
 */
async function roomSeeded(roomId?: string): Promise<boolean | null> {
  if (!roomId) return null
  try {
    const res = await fetch(`${API_BASE_URL}/api/collab/rooms`)
    const body = (await res.json().catch(() => null)) as {
      rooms?: { roomId?: string; seeded?: boolean }[]
    } | null
    const hit = body?.rooms?.find((r) => r.roomId === roomId)
    if (!hit) return null
    return hit.seeded === true
  } catch {
    return null
  }
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
    // 임베드용 선저장은 편집 세션을 유지한다 (수동 Save와 달리 편집을 끝내지
    // 않는다 — 끝나면 세션이 낡은 모델을 들고 있어 첨부 후 화면이 stale해진다).
    window.dispatchEvent(new CustomEvent<OfficeSaveRequestDetail>('officeSaveRequest', { detail: { keepEditing: true } }))
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
  const ok = await ctx.saveFirst().then(async (first) => {
    if (first) return true
    // 선저장 실패가 방 미시드(not_seeded) 탓이면 시드를 기다렸다가 1회만 재시도한다.
    if (ctx.waitSeed) {
      const seeded = await ctx.waitSeed()
      if (seeded && (await ctx.saveFirst())) return true
    }
    // 그래도 실패했는데 방이 한 번도 시드된 적 없으면 로컬에 플러시할 내용이 없다.
    // 디스크 기준으로 POST한다 (서버 dirty_room 검사가 디스크 레이스를 막는다).
    const seeded = await roomSeeded(ctx.roomId)
    if (seeded === false) return true
    return false
  })
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
