import { useState } from 'react'
import { API_BASE_URL } from '@/config'
import { showToast } from '@/lib/toast'
import type { MessageWithParts } from '@/api/types'
import {
  buildSessionHtml,
  buildSessionMarkdown,
  buildSessionText,
  downloadTextFile,
  printSessionPdf,
  sessionFileName,
} from '@/lib/sessionExport'

export type SelectedExportFormat = 'md' | 'txt' | 'html' | 'pdf' | 'json'

async function fetchSelectedMessages(ids: string[]): Promise<MessageWithParts[]> {
  const res = await fetch(`${API_BASE_URL}/api/session-messages/by-ids`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  if (!res.ok) throw new Error('선택 메시지를 불러오지 못했어요')
  const body = (await res.json()) as { messages: MessageWithParts[] }
  return body.messages ?? []
}

/** 선택 출력: 채팅 내보내기와 같은 md/txt/html/pdf(+json) 메뉴. */
export function SelectedExportButtons({ ids, title }: { ids: string[]; title?: string }) {
  const [busy, setBusy] = useState<SelectedExportFormat | null>(null)
  const run = async (format: SelectedExportFormat) => {
    if (ids.length === 0 || busy) return
    setBusy(format)
    try {
      const messages = await fetchSelectedMessages(ids)
      if (messages.length === 0) {
        showToast.error('불러온 메시지가 없어요 (삭제됐을 수 있어요)')
        return
      }
      const name = title || `선택 출력 ${messages.length}개`
      if (format === 'md') {
        downloadTextFile(sessionFileName(name, 'md'), buildSessionMarkdown(messages, name), 'text/markdown')
      } else if (format === 'txt') {
        downloadTextFile(sessionFileName(name, 'txt'), buildSessionText(messages, name), 'text/plain')
      } else if (format === 'html') {
        downloadTextFile(sessionFileName(name, 'html'), buildSessionHtml(messages, name, true), 'text/html')
      } else if (format === 'json') {
        downloadTextFile(sessionFileName(name, 'json'), JSON.stringify(messages, null, 2), 'application/json')
      } else {
        // 팝업 차단을 피하려 클릭 핸들러 안에서 직접 호출한다
        if (!printSessionPdf(messages, name)) showToast.error('팝업이 차단됐어요 — 팝업 허용 후 다시 눌러주세요')
      }
    } catch (e) {
      showToast.error((e as Error)?.message ?? '출력 실패')
    } finally {
      setBusy(null)
    }
  }
  const btn = 'text-[11px] px-2 py-1 rounded border border-input hover:bg-accent disabled:opacity-40'
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {( (['md', 'txt', 'html', 'pdf', 'json'] as const).map((f) => (
        <button key={f} onClick={() => void run(f)} disabled={ids.length === 0 || busy != null} className={btn}>
          {busy === f ? '…' : f.toUpperCase()}
        </button>
      )))}
    </div>
  )
}
