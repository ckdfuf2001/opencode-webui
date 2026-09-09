import { MoreHorizontal, FileText, FileType, FileCode2, Printer, ListOrdered } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { SessionExportFormat } from '@/lib/sessionExport'

interface SessionMoreMenuProps {
  onExport: (format: SessionExportFormat | 'pdf') => void
  onOpenJump: () => void
}

export function SessionMoreMenu({ onExport, onOpenJump }: SessionMoreMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="h-8 w-8 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
          title="More actions (download / jump / search)"
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground font-medium">Download all</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => onExport('md')} className="text-xs cursor-pointer">
          <FileText className="w-3.5 h-3.5 mr-2" /> Markdown (.md)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onExport('txt')} className="text-xs cursor-pointer">
          <FileType className="w-3.5 h-3.5 mr-2" /> Text (.txt)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onExport('html')} className="text-xs cursor-pointer">
          <FileCode2 className="w-3.5 h-3.5 mr-2" /> HTML
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onExport('pdf')} className="text-xs cursor-pointer">
          <Printer className="w-3.5 h-3.5 mr-2" /> PDF (print)
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onOpenJump} className="text-xs cursor-pointer">
          <ListOrdered className="w-3.5 h-3.5 mr-2" /> Search / Go to message…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
