import type { MessageWithParts } from '@/api/types'
import { stripMemoryRecall } from '@/lib/stripRecall'

export type SessionExportFormat = 'md' | 'txt' | 'html'

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function fmtTime(created?: number): string {
  if (!created) return ''
  try {
    return new Date(created).toLocaleString()
  } catch {
    return ''
  }
}

function roleLabel(msg: MessageWithParts): string {
  const info = msg.info as unknown as { role?: string; modelID?: string }
  if (info.role === 'user') return 'You'
  return (info.modelID as string) || 'Assistant'
}

/** 메시지 1개를 텍스트 라인들로 펼친다 (윈도우와 무관하게 전체 목록 기준). */
function messageLines(msg: MessageWithParts): string[] {
  const lines: string[] = []
  for (const raw of msg.parts) {
    const p = raw as unknown as Record<string, unknown> & { type?: string }
    switch (p.type) {
      case 'text': {
        const t = stripMemoryRecall(String((p as { text?: unknown }).text ?? '')).trim()
        if (t) lines.push(t)
        break
      }
      case 'reasoning': {
        const t = String((p as { text?: unknown }).text ?? '').trim()
        if (t) lines.push(`[thinking] ${t}`)
        break
      }
      case 'tool': {
        const st = (p as { state?: Record<string, unknown> }).state ?? {}
        const tool = String((p as { tool?: unknown }).tool ?? '?')
        const status = String(st.status ?? '?')
        lines.push(`[tool:${tool} (${status})]`)
        if (typeof st.title === 'string' && st.title) lines.push(`  ${st.title}`)
        if (st.input != null) lines.push(`  input: ${trunc(JSON.stringify(st.input), 800)}`)
        const out = (st.output ?? st.error) as unknown
        if (typeof out === 'string' && out) lines.push(`  output: ${trunc(out, 2000)}`)
        break
      }
      case 'file': {
        const f = (p as { filename?: unknown; url?: unknown }).filename ?? (p as { url?: unknown }).url ?? ''
        lines.push(`[file] ${String(f)}`)
        break
      }
      case 'agent': {
        lines.push(`[agent] ${trunc(JSON.stringify(p).slice(0, 500), 500)}`)
        break
      }
      case 'step-finish':
      case 'step-start':
      case 'snapshot':
        break
      default: {
        const t = (p as { text?: unknown }).text
        if (typeof t === 'string' && t.trim()) lines.push(t.trim())
        else if (p.type) lines.push(`[${String(p.type)}]`)
        break
      }
    }
  }
  return lines
}

export function buildSessionMarkdown(messages: MessageWithParts[], title: string): string {
  const out: string[] = [`# ${title}`, '']
  for (const m of messages) {
    const info = m.info as unknown as { time?: { created?: number } }
    const head = `## ${roleLabel(m)}${fmtTime(info.time?.created) ? ` — ${fmtTime(info.time?.created)}` : ''}`
    out.push(head, '')
    const lines = messageLines(m)
    out.push(...(lines.length > 0 ? lines : ['(empty)']), '')
  }
  return out.join('\n')
}

export function buildSessionText(messages: MessageWithParts[], title: string): string {
  const out: string[] = [title, '='.repeat(Math.min(title.length, 60)), '']
  for (const m of messages) {
    const info = m.info as unknown as { time?: { created?: number } }
    out.push(`[${roleLabel(m)}]${fmtTime(info.time?.created) ? ` ${fmtTime(info.time?.created)}` : ''}`)
    const lines = messageLines(m)
    out.push(...(lines.length > 0 ? lines : ['(empty)']), '')
  }
  return out.join('\n')
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function messageHtml(m: MessageWithParts): string {
  const info = m.info as unknown as { role?: string; modelID?: string; time?: { created?: number } }
  const role = roleLabel(m)
  const cls = info.role === 'user' ? 'user' : 'assistant'
  const lines = messageLines(m)
  const body = lines.length > 0
    ? lines.map((l) => `<p>${escHtml(l).replace(/\n/g, '<br>')}</p>`).join('\n')
    : '<p class="empty">(empty)</p>'
  return `<section class="msg ${cls}"><header><strong>${escHtml(role)}</strong>${fmtTime(info.time?.created) ? ` <span class="time">${escHtml(fmtTime(info.time?.created))}</span>` : ''}</header>${body}</section>`
}

const PRINT_CSS = `
body{font-family:system-ui,sans-serif;max-width:800px;margin:24px auto;padding:0 16px;color:#111}
.msg{border:1px solid #ddd;border-radius:8px;padding:10px 12px;margin:12px 0;page-break-inside:avoid}
.msg.user{background:#eef4ff}.msg.assistant{background:#f7f7f7}
.msg header{font-size:12px;color:#555;margin-bottom:6px}
.msg p{white-space:pre-wrap;font-size:13px;margin:6px 0}
.empty{color:#999}`

export function buildSessionHtml(messages: MessageWithParts[], title: string, standalone: boolean): string {
  const body = `<h1>${escHtml(title)}</h1>\n` + messages.map(messageHtml).join('\n')
  if (!standalone) return body
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`
}

export function sessionFileName(title: string, ext: string): string {
  const clean = (title || 'session').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_').slice(0, 50) || 'session'
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  return `${clean}_${stamp}.${ext}`
}

export function downloadTextFile(name: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/** PDF는 브라우저 인쇄(다른 이름으로 저장→PDF)로 내보낸다. 팝업 차단을 피하려 클릭 핸들러에서 직접 호출해야 한다. */
export function printSessionPdf(messages: MessageWithParts[], title: string): boolean {
  const w = window.open('', '_blank', 'width=900,height=700')
  if (!w) return false
  const body = `<h1>${escHtml(title)}</h1>\n` + messages.map(messageHtml).join('\n')
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title><style>${PRINT_CSS}</style></head><body>${body}<script>window.onload=()=>{window.focus();window.print()}<\/script></body></html>`)
  w.document.close()
  return true
}
