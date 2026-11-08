import { API_BASE_URL } from '@/config'

export type AttachmentKind = 'docx' | 'xlsx' | 'pptx'

export function attachmentKindOf(name: string): AttachmentKind | null {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') return ext
  return null
}

/** 첨부 열기 요청 (오버레이 → 마운트된 뷰어: 방 컨텍스트 부착). */
export const ATTACHMENT_OPEN_REQUEST = 'openAttachmentRequest'
/** 첨부 편집기 열기 (뷰어 → FilePreview 호스트: 전체화면 편집기 마운트). */
export const ATTACHMENT_OPEN_EVENT = 'openAttachmentEditor'

export interface AttachmentOpenRequest {
  parentPath: string
  parentName: string
  /** zip 안 정규 경로 (예: xl/embeddings/report.docx). */
  part: string
  /** 표시명 (CFB 원본명 또는 파트명). */
  name: string
  kind: AttachmentKind
}

export interface AttachmentOpenDetail extends AttachmentOpenRequest {
  roomId?: string
  clientId?: number
  /** true면 읽기 전용으로 연다 (잠금 선점/보기 모드). */
  readOnly?: boolean
  /** 선점자가 있을 때 표시할 이름. */
  holderName?: string
}

export function requestAttachmentOpen(d: AttachmentOpenRequest): void {
  window.dispatchEvent(new CustomEvent<AttachmentOpenRequest>(ATTACHMENT_OPEN_REQUEST, { detail: d }))
}

export function openAttachmentEditor(d: AttachmentOpenDetail): void {
  window.dispatchEvent(new CustomEvent<AttachmentOpenDetail>(ATTACHMENT_OPEN_EVENT, { detail: d }))
}

export interface AttachmentBytes {
  bytes: Uint8Array
  name: string
  /** GET 시점 부모 파일 해시 (PUT baseHash). */
  hash: string
  /** P0-4: GET 시점 파트 바이트 해시 (subtle 없이 knownHash·partHash로 쓴다). */
  partHash?: string
  size: number
}

export async function getAttachmentPart(
  parentPath: string,
  part: string,
  opts?: { roomId?: string; clientId?: number },
): Promise<AttachmentBytes> {
  const q = new URLSearchParams({ path: parentPath, part })
  if (opts?.roomId) q.set('roomId', opts.roomId)
  if (opts?.clientId !== undefined) q.set('clientId', String(opts.clientId))
  const res = await fetch(`${API_BASE_URL}/api/collab/embed?${q.toString()}`)
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    name?: string
    hash?: string
    partHash?: string
    size?: number
    data?: string
    code?: string
    error?: string
  }
  if (!res.ok || !body.ok || typeof body.data !== 'string' || !body.hash) {
    const e = new Error(body?.error || `첨부를 불러오지 못했습니다 (${res.status})`) as Error & {
      code?: string
    }
    if (body?.code) e.code = body.code
    throw e
  }
  const bin = atob(body.data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return { bytes, name: body.name ?? part.split('/').pop() ?? 'attachment', hash: body.hash, partHash: typeof body.partHash === 'string' ? body.partHash : undefined, size: body.size ?? bytes.length }
}

export interface AttachmentLock {
  lockId: string
  expiresAt: number
  renewed: boolean
}

export class AttachmentLockError extends Error {
  readonly code: string
  readonly holderName?: string
  constructor(code: string, message: string, holderName?: string) {
    super(message)
    this.code = code
    this.holderName = holderName
  }
}

async function postJson(path: string, body: unknown): Promise<{ res: Response; body: Record<string, unknown> }> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { res, body: data }
}

export async function acquireAttachmentLock(
  parentPath: string,
  part: string,
  holderName: string,
  token: string,
  lockId?: string,
): Promise<AttachmentLock> {
  const { res, body } = await postJson('/api/collab/embed/lock', {
    path: parentPath,
    part,
    name: holderName,
    token,
    ...(lockId ? { lockId } : {}),
  })
  if (!res.ok || !body.ok) {
    const code = typeof body.code === 'string' ? body.code : `http_${res.status}`
    throw new AttachmentLockError(
      code,
      typeof body.error === 'string' ? body.error : '잠금을 얻지 못했습니다',
      typeof body.holderName === 'string' ? body.holderName : undefined,
    )
  }
  return {
    lockId: body.lockId as string,
    expiresAt: body.expiresAt as number,
    renewed: body.renewed === true,
  }
}

export async function releaseAttachmentLock(
  parentPath: string,
  part: string,
  lockId: string,
  token: string,
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/collab/embed/lock`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: parentPath, part, lockId, token }),
  })
  await res.json().catch(() => ({}))
}

export interface AttachmentPutResult {
  ok: boolean
  newHash?: string
  code?: string
  error?: string
  currentHash?: string | null
  retryable?: boolean
}

export async function putAttachmentPart(
  parentPath: string,
  part: string,
  bytes: Uint8Array,
  opts: { baseHash?: string; lockId: string; roomId?: string; clientId?: number; fileName: string; partHash?: string },
): Promise<AttachmentPutResult> {
  const q = new URLSearchParams({ path: parentPath, part })
  const fd = new FormData()
  fd.append('file', new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' }), opts.fileName)
  if (opts.baseHash) fd.append('baseHash', opts.baseHash)
  if (opts.partHash) fd.append('partHash', opts.partHash)
  fd.append('lockId', opts.lockId)
  if (opts.roomId) fd.append('roomId', opts.roomId)
  if (opts.clientId !== undefined) fd.append('clientId', String(opts.clientId))
  const res = await fetch(`${API_BASE_URL}/api/collab/embed?${q.toString()}`, { method: 'PUT', body: fd })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    newHash?: string
    code?: string
    error?: string
    currentHash?: string | null
    retryable?: boolean
  }
  if (!res.ok || !body.ok) {
    return {
      ok: false,
      code: typeof body.code === 'string' ? body.code : `http_${res.status}`,
      error: body.error,
      currentHash: body.currentHash,
      retryable: body.retryable,
    }
  }
  return { ok: true, newHash: body.newHash }
}

/** 첨부 편집 화면에서 쓰는 뷰어용 저장 슬롯. */
export interface AttachmentSaver {
  /** 현재 모델 바이트를 PUT으로 저장. 성공 시 true. */
  saveNow: () => Promise<boolean>
  /** 저장 안 된 변경이 있는지. */
  isDirty: () => boolean
}
