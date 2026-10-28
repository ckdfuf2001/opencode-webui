/**
 * B0-5: 64KB 초과 파트의 capped 경로에서도 tool state.input을 보존한다.
 * 줄이는 대상은 output/metadata.output뿐이다. input은 명령어 타일이 의존하므로
 * 32KB 이하일 때 그대로 전달하고, 그 이상이면 생략한다(제목 폴백이 남는다).
 * bun:sqlite에 의존하지 않는 순수 함수 — vitest 단위 테스트용.
 */

export const CAPPED_INPUT_KEEP = 32 * 1024
const CAPPED_HEAD_KEEP = 20000
const TRUNCATE_NOTICE = '\n\n…[output truncated for memory — see full log in session]'

export interface CappedToolRow {
  status: string | null
  title: string | null
  timejson: string | null
  statetime: string | null
  hasout: number | null
  outhead: string | null
  metahead: string | null
  inputjson: string | null
  len: number | null
}

function safeParse(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {}
  try {
    const v = JSON.parse(json) as unknown
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function buildCappedToolState(r: CappedToolRow): Record<string, unknown> {
  const notice = `${TRUNCATE_NOTICE} (${Math.max(0, (r.len ?? 0) - CAPPED_HEAD_KEEP)} chars omitted)`
  const state: Record<string, unknown> = { status: r.status ?? 'completed' }
  if (r.title) state.title = r.title
  if (r.timejson) state.time = safeParse(r.statetime)
  if (r.hasout) state.output = `${r.outhead ?? ''}${notice}`
  else state.metadata = { output: `${r.metahead ?? ''}${notice}` }
  if (r.inputjson && r.inputjson.length <= CAPPED_INPUT_KEEP) {
    const parsed = safeParse(r.inputjson)
    if (Object.keys(parsed).length > 0 || r.inputjson.trim() === '{}') state.input = parsed
  }
  return state
}
