import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NavigationTree } from './NavigationTree'

interface NavigationPanelProps {
  open: boolean
  onClose: () => void
  onNewRepo?: () => void
}

export function NavigationPanel({ open, onClose, onNewRepo }: NavigationPanelProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-40" style={{ pointerEvents: open ? 'auto' : 'none' }}>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="absolute top-0 left-0 bottom-0 w-full sm:w-[380px] sm:max-w-[85vw] flex flex-col bg-background border-r sm:border-r border-border shadow-2xl">
        <div className="flex items-center justify-between px-3 py-3 border-b border-border flex-shrink-0">
          <h2 className="text-sm font-semibold">네비게이션</h2>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
            <X className="w-4 h-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <NavigationTree onNavigate={onClose} onNewRepo={onNewRepo} />
        </div>
      </div>
    </div>
  )
}
