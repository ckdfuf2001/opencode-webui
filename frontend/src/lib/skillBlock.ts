/**
 * 스킬 호출 표시 파서.
 * 백엔드(dispatchQueuedChat)가 합성한 유저 메시지 형식:
 *   /스킬명 인자
 *
 *   <!-- skill-template:스킬명 -->
 *   템플릿 본문 (markdown)
 *   <!-- /skill-template -->
 * 첫 줄(`/스킬 인자`)은 칩으로 먼저 보이고, 템플릿은 접힘 md 블록으로 그린다.
 */

export interface SkillInvocation {
  name: string
  args: string
  body: string
}

const SKILL_OPEN_RE = /^\/(\S+)([^\n]*)\n\n<!-- skill-template:(\S+) -->\n?/
const SKILL_CLOSE_RE = /\n?<!-- \/skill-template -->\s*$/

export function parseSkillInvocation(text: string): SkillInvocation | null {
  const trimmed = text.trim()
  const m = trimmed.match(SKILL_OPEN_RE)
  if (!m) return null
  const name = m[1] ?? ''
  const marker = m[3] ?? ''
  // 헤드와 마커의 스킬명이 다르면 일반 텍스트로 둔다 (오탐 방지)
  if (!name || marker !== name) return null
  let body = trimmed.slice(m[0].length).replace(SKILL_CLOSE_RE, '').trim()
  if (!body) return null
  return { name, args: (m[2] ?? '').trim(), body }
}
