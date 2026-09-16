import { useState } from 'react'
import { Download, FileText, FileType, FileCode2, Printer, FileJson } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { API_BASE_URL } from '@/config'
import { showToast } from '@/lib/toast'
import type { MessageWithParts } from '@/api/types'
import {
  buildSessionHtml,
  buildSessionMarkdown,
  buildSessionText,
  downloadTextFile,
  printSessionPdfInto,
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

/** 선택 출력: 채팅 내보내기와 같은 드롭다운 (md/txt/html/pdf/json). */
export function SelectedExportButtons({ ids, title }: { ids: string[]; title?: string }) {
  const [busy, setBusy] = useState<SelectedExportFormat | null>(null)
  const run = async (format: SelectedExportFormat) => {
    if (ids.length === 0 || busy) return
    // PDF는 fetch 전에 창을 먼저 열어야 팝업 차단을 피한다
    let pdfWin: Window | null = null
    if (format === 'pdf') {
      pdfWin = window.open('', '_blank', 'width=900,height=700')
      if (!pdfWin) {
        showToast.error('팝업이 차단됐어요 — 팝업 허용 후 다시 눌러주세요')
        return
      }
    }
    setBusy(format)
    try {
      const messages = await fetchSelectedMessages(ids)
      if (messages.length === 0) {
        pdfWin?.close()
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
      } else if (pdfWin) {
        printSessionPdfInto(pdfWin, messages, name)
      }
    } catch (e) {
      pdfWin?.close()
      showToast.error((e as Error)?.message ?? '출력 실패')
    } finally {
      setBusy(null)
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          disabled={ids.length === 0 || busy != null}
          title="선택 출력 (md/txt/html/pdf/json)"
          className="h-7 px-2 text-xs rounded-md border border-input bg-background hover:bg-accent inline-flex items-center gap-1 disabled:opacity-40"
        >
          <Download className="w-3.5 h-3.5" />
          {busy ? '…' : `선택 출력 (${ids.length})`}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs text-muted-foreground font-medium">선택 {ids.length}개 내보내기</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void run('md')} className="text-xs cursor-pointer">
          <FileText className="w-3.5 h-3.5 mr-2" /> Markdown (.md)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void run('txt')} className="text-xs cursor-pointer">
          <FileType className="w-3.5 h-3.5 mr-2" /> Text (.txt)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void run('html')} className="text-xs cursor-pointer">
          <FileCode2 className="w-3.5 h-3.5 mr-2" /> HTML
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void run('pdf')} className="text-xs cursor-pointer">
          <Printer className="w-3.5 h-3.5 mr-2" /> PDF (print)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void run('json')} className="text-xs cursor-pointer">
          <FileJson className="w-3.5 h-3.5 mr-2" /> JSON
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
