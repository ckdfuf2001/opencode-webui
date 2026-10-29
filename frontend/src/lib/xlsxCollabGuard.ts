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

/** true면 막는다. undo/redo는 되돌리는 op 기준으로 판정한다(우회 방지). */
export function isBlockedXlsxEdit(kind: string, label: string): boolean {
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
