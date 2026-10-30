/**
 * C3: 동시편집 중 방에 실리지 않는 편집을 막는 판정.
 *
 * lib 패치(ooxml-core xlsx run2 진입점)는 `globalThis.__ooxmlEditGuard(label, kind)`
 * 를 호출하고, false가 돌아오면 적용 전에 버린다(롤백·히스토리 무기록·workbook-change
 * 미발생이라 자동 저장도 안 걸린다). 판정 로직은 여기(앱)에만 둔다. lib를 고치지 않고
 * 목록을 바꾸려면 이 파일만 고치면 된다.
 *
 * - kind "annotations"는 전부 막는다(코멘트/하이퍼링크/유효성/그림/차트/이미지).
 * - "format"/"structure"/"sheets"는 미공유 라벨만 막는다 (셀 서식·병합·시트 자체는 통과).
 */

export type XlsxEditKind = string

/** format 중 방에 안 실리는 것 (셀 서식은 styles로 공유되므로 허용). */
export const XLSX_UNSYNCED_FORMAT_LABELS: readonly string[] = [
  'Conditional formatting',
  'Clear rules',
  'Edit rule',
  'Delete rule',
  'Rule priority',
] as const

/** structure 중 방에 안 실리는 것 (시트 자체는 sheets 전체 쓰기로 공유). */
export const XLSX_UNSYNCED_STRUCTURE_LABELS: readonly string[] = [
  'Create table',
  'Resize table',
  'Rename table',
  'Table options',
  'Convert to range',
] as const

/** sheets 중 방에 안 실리는 것. */
export const XLSX_UNSYNCED_SHEETS_LABELS: readonly string[] = [
  'Protect sheet',
  'Unprotect sheet',
  'Protect workbook',
  'Unprotect workbook',
] as const

/** annotations 라벨 (kind로 막히지만 undo/redo 판정과 dist grep용으로 둔다). */
export const XLSX_UNSYNCED_ANNOTATION_LABELS: readonly string[] = [
  'Move object',
  'Delete object',
  'Insert picture',
  'Edit chart',
  'Insert chart',
  'New comment',
  'Edit comment',
  'Delete comment',
  'Insert link',
  'Remove link',
  'Data validation',
  'Clear validation',
  'Clear comments',
  'Clear hyperlinks',
] as const

const FORMAT_DENY = new Set<string>(XLSX_UNSYNCED_FORMAT_LABELS)
const STRUCTURE_DENY = new Set<string>(XLSX_UNSYNCED_STRUCTURE_LABELS)
const SHEETS_DENY = new Set<string>(XLSX_UNSYNCED_SHEETS_LABELS)
const ANNOTATION_LABELS = new Set<string>(XLSX_UNSYNCED_ANNOTATION_LABELS)

/**
 * C4: 개체 op 라벨. 서버 개체 표 + 락으로 판정하므로 가드에서는 통과시키고
 * (거부 사유: embLocked solo 포함 / mismatch fail-closed / activeKey가 남의 락),
 * 서버 409가 최종 판정이다.
 */
export const XLSX_OBJECT_LABELS: readonly string[] = ['Move object', 'Delete object'] as const
const OBJECT_LABELS = new Set<string>(XLSX_OBJECT_LABELS)

/** C4: 개체 op 가드 판정 입력. */
export interface ObjectGuardCtx {
  /** 시트에 surgical oleObj(EMB)가 있으면 전체 개체 op 잠금 (solo 포함). */
  embLocked: boolean
  /** 키 대응 실패 시 전체 개체 op 잠금 (fail-closed). */
  mismatch: boolean
  /** pointerdown으로 잡은 개체 키 (없으면 undo·키보드·프로그래밍 경로). */
  activeKey: string | null
  /** 다른 사람이 잡은 락의 키 집합 (로컬 개체 표 기준). */
  foreignKeys: ReadonlySet<string>
  /** lib 소켓 연결 여부. 끊기면 서버 강제가 안 되니 전체 개체 op 잠금. */
  online: boolean
}

/** 'pass'면 통과, 아니면 거부 사유. */
export type ObjectGuardVerdict = 'pass' | 'emb' | 'mismatch' | 'foreign' | 'offline'

export function decideObjectOp(_kind: string, _label: string, ctx: ObjectGuardCtx): ObjectGuardVerdict {
  if (!ctx.online) return 'offline'
  if (ctx.embLocked) return 'emb'
  if (ctx.mismatch) return 'mismatch'
  if (ctx.activeKey !== null && ctx.foreignKeys.has(ctx.activeKey)) return 'foreign'
  return 'pass'
}

export const NO_OBJECT_GUARD: ObjectGuardCtx = { embLocked: false, mismatch: false, activeKey: null, foreignKeys: new Set(), online: true }

/** C4: surgical oleObj(EMB)가 drawings에 있으면 true. 실물 EMB는 모델에 안 들어온다. */
export function hasEmbObject(drawings: ReadonlyArray<{ sourceXml?: string } | null | undefined> | undefined): boolean {
  if (!drawings) return false
  return drawings.some((d) => typeof d?.sourceXml === 'string' && d.sourceXml.includes('oleObj'))
}

/** true면 막는다. undo/redo는 되돌리는 op 기준으로 판정한다(우회 방지). */
export function isBlockedXlsxEdit(kind: string, label: string, objCtx?: ObjectGuardCtx): boolean {
  // C4: 개체 이동·삭제는 개체 표 + 락으로 판정한다 (서버가 최종 판정).
  // undo/redo 로 되돌리는 경우도 같은 경로로 간다(서버 enforce).
  // 단, 삭제의 undo/redo는 막는다: 서버 부활 API 없이 되살리면 표·상대가
  // 어긋나 조용히 발산한다 (fail-closed). 이동의 undo/redo는 그냥 이동이다.
  if (OBJECT_LABELS.has(label) && (kind === 'annotations' || kind === 'undo' || kind === 'redo')) {
    if ((kind === 'undo' || kind === 'redo') && label === 'Delete object') return true
    return decideObjectOp(kind, label, objCtx ?? NO_OBJECT_GUARD) !== 'pass'
  }
  if (kind === 'annotations') return true
  if (kind === 'format' && FORMAT_DENY.has(label)) return true
  if (kind === 'structure' && STRUCTURE_DENY.has(label)) return true
  if (kind === 'sheets' && SHEETS_DENY.has(label)) return true
  if ((kind === 'undo' || kind === 'redo') && isUnsyncedLabel(label)) return true
  return false
}

function isUnsyncedLabel(label: string): boolean {
  return FORMAT_DENY.has(label) || STRUCTURE_DENY.has(label) || SHEETS_DENY.has(label) || ANNOTATION_LABELS.has(label)
}

/** 1→2 참가 시 즉시 저장이 필요한지. debounce를 건너뛰고 바로 저장한다. */
export function shouldFlushOnPeerArrive(opts: {
  /** 내 편집이 아직 방에 안 올라감 */
  hasPendingAutosave: boolean
  /** 내가 현재 owner인지 (rooms() 참가자 목록 기준) */
  isOwner: boolean | undefined
  /** 방에 붙어 있는지 (joined) */
  joined: boolean
}): boolean {
  if (!opts.joined) return false
  if (!opts.hasPendingAutosave) return false
  // owner가 아니면 저장하면 안 된다. 모르면(미선출·조회 실패) 잠금에 맡기고 보내지 않는다.
  if (opts.isOwner !== true) return false
  return true
}
